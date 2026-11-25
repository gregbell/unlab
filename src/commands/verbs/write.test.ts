import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FileOutcome, FilePort, GuestFile } from "../define.ts";
import { completeLine, isLineError, type ParsedLine } from "../index.ts";
import { NO_EXEC } from "../testing/lab.ts";
import { storeLab } from "../testing/store.ts";
import { MAX_TEXT_BYTES } from "./write.ts";

const WRITTEN: FileOutcome = { kind: "written", path: "/etc/motd", owner: "root:root", mode: "644" };

async function oneReady(outcome: FileOutcome = WRITTEN) {
	const written: { machine: string; file: GuestFile }[] = [];
	const files: FilePort = {
		async write(machine, file, signal) {
			signal.throwIfAborted();
			written.push({ machine, file });
			return outcome;
		},
	};
	const lab = storeLab(NO_EXEC, files);
	await lab.lab(1);
	return { lab, written };
}

type Lab = Awaited<ReturnType<typeof oneReady>>["lab"];

const fileOf = (line: ParsedLine) => line.args as { path: string; text: string; owner: string; mode: string };

function toolOf(lab: Lab) {
	const tool = lab.registry.find("write")?.tool;
	if (!tool) throw new Error("write has no tool");
	return tool;
}

/** What an agent's input comes to, through the line it is written as. */
function asked(lab: Lab, input: object): ParsedLine {
	const line = toolOf(lab).toLine({ machine: "node1", path: "/etc/motd", ...input });
	if (typeof line !== "string") throw new Error(line.message);
	return lab.parsed(line);
}

function refusalOf(lab: Lab, line: string): string {
	const parsed = lab.parse(line);
	const error = isLineError(parsed) ? parsed : parsed.validate(lab.store.state);
	if (!error) throw new Error(`${line} was not refused`);
	return error.message.replace(" Nothing was changed.", "");
}

describe("write", () => {
	it("writes the text after -- and says what it did", async () => {
		const { lab, written } = await oneReady();
		const line = lab.parsed("write node1 /etc/motd --mode 600 --owner root:adm -- hello  there ");
		expect(line.preview(lab.store.state)).toEqual({
			will: "write /etc/motd on node1 · 1 line, 13 bytes · owner root:adm · mode 600",
			assumed: null,
			tone: "plain",
		});
		expect(await lab.run(line.line)).toEqual({
			kind: "report",
			header: "wrote /etc/motd on node1 · 1 line, 13 bytes · root:root 644",
			blocks: [],
			data: { machine: "node1", path: "/etc/motd", bytes: 13, owner: "root:root", mode: "644" },
		});
		expect(written).toEqual([
			{
				machine: "node1",
				file: { path: "/etc/motd", text: "hello  there ", owner: "root:adm", mode: "600" },
			},
		]);
	});

	it("takes nothing after -- for an empty file, and wants the --", async () => {
		const { lab } = await oneReady();
		for (const line of ["write node1 /etc/motd --", "write node1 /etc/motd -- "]) {
			expect(fileOf(lab.parsed(line)).text).toBe("");
			expect(lab.parsed(line).preview(lab.store.state)).toMatchObject({ will: "write /etc/motd on node1 · empty" });
		}
		expect(refusalOf(lab, "write node1 /etc/motd")).toBe("write wants a text after --.");
	});

	it("gives an agent's text to the guest as it is, whatever is in it", async () => {
		const { lab } = await oneReady();
		const text = (value: string) => fileOf(asked(lab, { text: value })).text;
		const seen = ["", " ", "\n", "\t\n ", "--", "-- --mode 600", "--owner x", "a\r\nb\r", "﻿ x", "\0", "$'\\\"`"];
		for (const value of seen) expect(text(value)).toBe(value);
		fc.assert(fc.property(fc.string({ unit: "binary" }), (value) => text(value) === value));
		fc.assert(fc.property(fc.stringMatching(/^[\s\\-]*$/), (value) => text(value) === value));
	});

	it("gives an agent's path to the guest as it is, spaces and backslashes too", async () => {
		const { lab } = await oneReady();
		const path = (value: string) => fileOf(asked(lab, { path: value, text: "a" })).path;
		for (const value of [
			"/a b",
			"/a  b/ c",
			String.raw`/a\b`,
			"/a\\",
			String.raw`/\\ \ `,
			'/it\'s "$x" `y`',
			"/é 日本",
			"/-- --mode",
		]) {
			expect(path(value)).toBe(value);
		}
		fc.assert(
			fc.property(fc.stringMatching(/^[a \\ '"$-]{0,12}$/), (rest) => {
				expect(path(`/x${rest}y`)).toBe(`/x${rest}y`);
				expect(path(`/x${rest}`)).toBe(`/x${rest}`);
			}),
		);
		expect(fileOf(lab.parsed(String.raw`write node1 /a\ b -- x`)).path).toBe("/a b");
		expect(path("//etc///motd")).toBe("/etc/motd");
	});

	it("refuses a path that is not a file's from the root", async () => {
		const { lab } = await oneReady();
		const refused = (path: string) => refusalOf(lab, `write node1 ${path} -- a`);
		expect(refused("etc/motd")).toBe("write wants a path that starts with /, such as /etc/motd, not etc/motd.");
		expect(refused("~/motd")).toBe("write wants a path that starts with /, such as /etc/motd, not ~/motd.");
		expect(refused("/etc/")).toBe("/etc/ names a directory, so give the path of a file in it, such as /etc/motd.");
		expect(refused("/")).toBe("/ names a directory, so give the path of a file in it, such as /motd.");
		expect(refused("/etc/../motd")).toBe("/etc/../motd has a part that is only dots, so give the path without it.");
		expect(refused("/a\x07b")).toBe("write wants a path with no control characters.");
		expect(refused(`/${"é".repeat(2048)}`)).toBe("A path has at most 4095 bytes, and that is 4097.");
		expect(toolOf(lab).toLine({ machine: "node1", path: "", text: "a" })).toMatchObject({
			message: expect.stringContaining("path must be one word"),
		});
	});

	it("refuses an owner and a mode that cannot be", async () => {
		const { lab } = await oneReady();
		const refused = (option: string) => refusalOf(lab, `write node1 /a ${option} -- a`);
		const owners = ["a:b:c", ":adm", "root:", "a;b", "4294967295", "root:99999999999"];
		for (const owner of owners) {
			expect(refused(`--owner ${owner}`)).toBe(
				`--owner wants a user or user:group, such as root or www-data:adm, not ${owner}.`,
			);
		}
		for (const mode of ["64", "888", "u+x", "00644", "0o644"]) {
			expect(refused(`--mode ${mode}`)).toBe(`--mode wants three or four octal digits, such as 644, not ${mode}.`);
		}
		expect(fileOf(asked(lab, { mode: 755, owner: "1000:100", text: "" }))).toMatchObject({
			mode: "755",
			owner: "1000:100",
		});
	});

	it("refuses a text that is too large or is not text, naming it", async () => {
		const { lab, written } = await oneReady();
		const refused = (text: string) => asked(lab, { text }).validate(lab.store.state)?.message;
		expect(refused("é".repeat(MAX_TEXT_BYTES / 2))).toBeUndefined();
		expect(refused("é".repeat(MAX_TEXT_BYTES / 2 + 1))).toBe(
			`text has ${MAX_TEXT_BYTES + 2} bytes, and write takes at most ${MAX_TEXT_BYTES}. Nothing was changed.`,
		);
		expect(refused("a\ud800b")).toMatch(/^text has half of a surrogate pair .*Nothing was changed\.$/);
		expect(toolOf(lab).toLine({ machine: "node1", path: "/a", text: 5 })).toMatchObject({
			message: "text must be a string, not 5. Nothing was changed.",
		});
		expect(toolOf(lab).toLine({ machine: "node1", path: "/a" })).toMatchObject({
			message: 'write needs the text field, such as "hello". Nothing was changed.',
		});
		expect(written).toEqual([]);
	});

	it("refuses a machine that is not ready, naming its state", async () => {
		const { lab } = await oneReady();
		await lab.run("spawn 1 alpine");
		expect(refusalOf(lab, "write node2 /a -- b")).toBe("write wants a ready machine here, and node2 is still booting.");
		await lab.run("poweroff node1");
		expect(refusalOf(lab, "write node1 /a -- b")).toBe("write wants a ready machine here, and node1 is off.");
	});

	it("says nothing was changed only when that is known", async () => {
		const refused = await oneReady({ kind: "refused", reason: "/etc on node1 is a directory." });
		expect(await refused.lab.run("write node1 /etc -- a")).toEqual({
			kind: "failed",
			error: { message: "/etc on node1 is a directory. Nothing was changed." },
		});
		expect(refused.lab.events.at(-1)).toMatchObject({ type: "cmd/logged", outcome: "failed" });
		const unsure = await oneReady({ kind: "unsure", reason: "node1 rebooted while /a was being written." });
		expect(await unsure.lab.run("write node1 /a -- a")).toEqual({
			kind: "failed",
			error: { message: "node1 rebooted while /a was being written." },
		});
	});

	it("leaves a text that does not read as a line out of the log, with its --", async () => {
		const { lab } = await oneReady();
		const logged = async (text: string) => {
			const line = asked(lab, { mode: "600", text });
			if (line.danger) throw new Error("write is safe");
			await line.run({ source: "agent", signal: lab.signal });
			return lab.store.state.log.at(-1)?.line;
		};
		expect(await logged("one short line")).toBe("write node1 /etc/motd --mode 600 -- one short line");
		for (const text of ["two\nlines", "x".repeat(201), "\x1b[2J", "right‮left", "last\n"]) {
			expect(await logged(text)).toBe("write node1 /etc/motd --mode 600");
			expect(asked(lab, { text }).shown).toEqual({ line: "write node1 /etc/motd", text });
		}
		expect(refusalOf(lab, "write node1 /etc/motd --mode 600")).toBe("write wants a text after --.");
	});

	it("completes the machine, the options and their values", async () => {
		const { lab } = await oneReady();
		const offered = (line: string) =>
			completeLine(lab.registry, line, line.length, lab.store.state).suggestions.map((s) => s.insert);
		expect(offered("wr")).toEqual(["write"]);
		expect(offered("write ")).toEqual(["node1"]);
		expect(offered("write node1 /etc/motd ")).toEqual(["--owner", "--mode", "--"]);
		expect(offered("write node1 /etc/motd --mode 6")).toEqual(["644", "600"]);
		expect(offered("write node1 /etc/motd --owner r")).toEqual(["root"]);
		expect(offered("write node1 /etc/motd -- n")).toEqual([]);
		const slot = (line: string) => completeLine(lab.registry, line, line.length, lab.store.state).slot;
		expect([slot("write node1 /e"), slot("write node1 /etc/motd --mode 6"), slot("write node1 /e -- a")]).toEqual([
			1, 3, 4,
		]);
	});
});
