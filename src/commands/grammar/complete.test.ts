import { describe, expect, it } from "vitest";
import { completeLine } from "../index.ts";
import { labWith } from "../testing/lab.ts";
import { toyRegistry } from "../testing/verbs.ts";

const lab = labWith([{ n: 1 }, { n: 2, shells: 1 }, { n: 3, link: "cut" }, { n: 4, phase: "booting" }]);
const { registry } = toyRegistry(lab);
const at = (line: string, caret = line.length) => completeLine(registry, line, caret, lab);
const inserts = (line: string, caret?: number) => at(line, caret).suggestions.map((s) => s.insert);

describe("completion", () => {
	it("offers every verb on an empty line, with what it does", () => {
		const { suggestions, replace } = at("");
		expect(suggestions.map((s) => s.insert)).toEqual(["spawn", "rm", "ls", "exec", "link", "capture", "focus", "boot"]);
		expect(suggestions[0]).toEqual({ insert: "spawn", label: "spawn", detail: "Boots machines" });
		expect(replace).toEqual({ start: 0, end: 0 });
	});

	it("filters by the start of the token under the caret", () => {
		expect(at("sp")).toMatchObject({ replace: { start: 0, end: 2 }, suggestions: [{ insert: "spawn" }] });
		expect(inserts("link d")).toEqual(["down"]);
	});

	it("uses only what is typed before the caret and replaces the whole token", () => {
		const completion = at("link dxxx node1", 6);
		expect(completion.suggestions.map((s) => s.insert)).toEqual(["down"]);
		expect(completion.replace).toEqual({ start: 5, end: 9 });
		expect(completion.slot).toBe(0);
	});

	it("offers counts, then images, by position", () => {
		expect(at("spawn ")).toMatchObject({ slot: 0, suggestions: [{ insert: "1" }, { insert: "2" }, { insert: "3" }] });
		expect(at("spawn 2 al")).toMatchObject({
			slot: 1,
			suggestions: [{ insert: "alpine", label: "alpine", detail: "alpine 3.24" }],
		});
	});

	it("offers machines the verb can act on, each with its address, link state and hue, plus all", () => {
		const { suggestions, slot } = at("link down ");
		expect(slot).toBe(1);
		expect(suggestions).toEqual([
			{ insert: "node1", label: "node1", detail: "10.88.0.11 · up", hue: 1 },
			{ insert: "node2", label: "node2", detail: "10.88.0.12 · up", hue: 2 },
			{ insert: "node3", label: "node3", detail: "10.88.0.13 · down", hue: 3 },
			{ insert: "all", label: "all", detail: "every machine that can take it" },
		]);
	});

	it("continues a comma list with the machines not yet in it", () => {
		expect(inserts("link down node1,")).toEqual(["node1,node2", "node1,node3"]);
		expect(inserts("link down node1,node3")).toEqual(["node1,node3"]);
	});

	it("offers the options not yet used once the positionals are filled", () => {
		expect(at("spawn 2 alpine ").suggestions).toEqual([
			{ insert: "--mem", label: "--mem MiB" },
			{ insert: "--net", label: "--net switch0" },
			{ insert: "--no-net", label: "--no-net" },
		]);
		expect(inserts("spawn 2 alpine --no-net ")).toEqual(["--mem"]);
		expect(inserts("spawn 2 --n")).toEqual(["--net", "--no-net"]);
	});

	it("offers values after an option", () => {
		expect(at("spawn 2 alpine --mem ")).toMatchObject({
			slot: 2,
			suggestions: [{ insert: "128" }, { insert: "256" }, { insert: "512" }],
		});
		expect(inserts("spawn 2 alpine --net ")).toEqual(["switch0"]);
	});

	it("offers -- where a command follows, and nothing inside the command", () => {
		expect(at("exec all ").suggestions).toEqual([{ insert: "--", label: "-- <command>" }]);
		expect(at("exec all -- pi")).toEqual({ replace: { start: 14, end: 14 }, suggestions: [], slot: 1 });
	});

	it("offers a machine's sessions where a session can go", () => {
		expect(inserts("focus node2")).toEqual(["node2", "node2:console", "node2:sh1"]);
	});

	it("offers nothing after an unknown verb", () => {
		expect(at("frob ").suggestions).toEqual([]);
	});
});
