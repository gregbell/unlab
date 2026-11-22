import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLine } from "../index.ts";
import { labWith } from "../testing/lab.ts";
import { capture, exec, focus, link, parsedOk, spawn, toyRegistry } from "../testing/verbs.ts";
import { tokenize } from "./tokenize.ts";

const lab = labWith([
	{ n: 1 },
	{ n: 2, shells: 2 },
	{ n: 3, link: "cut" },
	{ n: 4, phase: "booting" },
	{ n: 5, phase: "failed" },
	{ n: 12 },
]);
const { registry } = toyRegistry(lab);

describe("signature", () => {
	it("is derived from the grammar, in the handoff's notation", () => {
		expect(registry.command(spawn).signature).toEqual([
			"<count>",
			"<image>",
			"[--mem MiB]",
			"[--net switch0 | --no-net]",
		]);
		expect(registry.command(link).signature).toEqual(["<up | down>", "<machines>"]);
		expect(registry.command(exec).signature).toEqual(["<machines>", "-- <command>"]);
		expect(registry.command(focus).signature).toEqual(["<machine or session>", "[--main | --max]"]);
		expect(registry.command(capture).signature).toEqual(["<filter>"]);
	});
});

describe("format", () => {
	it("writes the canonical line: single spaces, positionals first, defaults left out", () => {
		const line = (typed: string) => parsedOk(parseLine(registry, typed, lab)).line;
		expect(line("spawn  --no-net 2   alpine --mem 512")).toBe("spawn 2 alpine --mem 512 --no-net");
		expect(line("spawn 2 alpine --net switch0 --mem 256")).toBe("spawn 2 alpine");
		expect(line("exec node1,node2 --   uname  -a")).toBe("exec node1,node2 -- uname  -a");
		expect(line("focus node2:sh1 --max")).toBe("focus node2:sh1 --max");
		expect(line("capture")).toBe("capture");
	});
});

const space = fc.stringMatching(/^ {1,3}$/);

/** A line built from tokens with random spacing, then parsed: format must give back the same arguments. */
function roundTrips(typed: string): void {
	const first = parsedOk(parseLine(registry, typed, lab));
	const again = parsedOk(parseLine(registry, first.line, lab));
	expect(again.args).toEqual(first.args);
	expect(again.line).toBe(first.line);
}

function spaced(tokens: readonly string[], gaps: readonly string[]): string {
	return tokens.map((t, i) => (i === 0 ? t : `${gaps[i % gaps.length]}${t}`)).join("");
}

describe("parse(format(a)) ≡ a", () => {
	it("holds for spawn arguments", () => {
		const command = registry.command(spawn);
		fc.assert(
			fc.property(
				fc.record({
					count: fc.integer({ min: 1, max: 1_000_000 }),
					image: fc.constantFrom("alpine", "debian"),
					mem: fc.integer({ min: 1, max: 1_000_000 }),
					net: fc.constantFrom<"switch0" | "none">("switch0", "none"),
				}),
				(args) => {
					const parsed = command.parse(tokenize(command.format(args)), lab);
					expect(parsed).toMatchObject({ args });
				},
			),
		);
	});

	it("holds for free text", () => {
		const command = registry.command(capture);
		const word = fc.stringMatching(/^[a-z0-9.:=]{1,8}$/);
		fc.assert(
			fc.property(fc.array(word, { maxLength: 6 }), (words) => {
				const args = { filter: words.join(" ") };
				expect(command.parse(tokenize(command.format(args)), lab)).toMatchObject({ args });
			}),
		);
	});

	it("holds for machine lists, globs and all with options in any order", () => {
		const part = fc.constantFrom("node1", "node2", "node3", "node4", "node5", "node12", "node*", "node1*", "all");
		fc.assert(
			fc.property(
				fc.array(part, { minLength: 1, maxLength: 4 }),
				fc.constantFrom("up", "down"),
				fc.array(space, { minLength: 1, maxLength: 4 }),
				(parts, dir, gaps) => {
					roundTrips(spaced(["link", dir, ["node1", ...parts].join(",")], gaps));
				},
			),
		);
	});

	it("holds for passthrough commands, whatever they contain", () => {
		const command = fc.string({ minLength: 1 }).filter((c) => !/^\s/.test(c) && !/[\r\n]/.test(c));
		fc.assert(
			fc.property(command, fc.constantFrom("all", "node1,node2", "node*"), (text, targets) => {
				roundTrips(`exec ${targets} -- ${text}`);
				expect(parsedOk(parseLine(registry, `exec ${targets} -- ${text}`, lab)).args).toMatchObject({ command: text });
			}),
		);
	});

	it("holds for spawn lines with options typed anywhere", () => {
		const option = fc.constantFrom([], ["--mem", "512"], ["--mem", "256"]);
		const net = fc.constantFrom([], ["--net", "switch0"], ["--no-net"]);
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 99 }),
				option,
				net,
				fc.boolean(),
				fc.array(space, { minLength: 1, maxLength: 4 }),
				(count, mem, network, optionsFirst, gaps) => {
					const positionals = [String(count), "debian"];
					const options = [...mem, ...network];
					const tokens = optionsFirst ? [...options, ...positionals] : [...positionals, ...options];
					roundTrips(spaced(["spawn", ...tokens], gaps));
				},
			),
		);
	});

	it("holds for sessions and exclusive bare flags", () => {
		const target = fc.constantFrom("node1", "node2", "node2:console", "node2:sh1", "node2:sh2", "node12:console");
		const mode = fc.constantFrom([], ["--main"], ["--max"]);
		fc.assert(fc.property(target, mode, (t, m) => roundTrips(["focus", t, ...m].join(" "))));
	});
});
