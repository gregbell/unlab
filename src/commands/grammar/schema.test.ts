import { describe, expect, it } from "vitest";
import { parseLine } from "../index.ts";
import { labWith } from "../testing/lab.ts";
import { exec, focus, ls, parsedOk, rm, spawn, toyRegistry } from "../testing/verbs.ts";

const lab = labWith([{ n: 1 }, { n: 2 }, { n: 3 }]);
const { registry } = toyRegistry(lab);
const toolOf = (verb: Parameters<typeof registry.command>[0]) => {
	const tool = registry.command(verb).tool;
	if (!tool) throw new Error(`${verb.name} has no tool`);
	return tool;
};

describe("tool input schema", () => {
	it("has a field per argument, the positionals required, nothing else allowed", () => {
		const schema = toolOf(spawn).inputSchema;
		expect(schema).toMatchObject({ type: "object", required: ["count", "image"], additionalProperties: false });
		expect(schema.properties?.count).toEqual({ type: "integer", minimum: 1, description: "How many." });
		expect(schema.properties?.image).toMatchObject({ type: "string" });
		expect(schema.properties?.mem).toEqual({ type: "integer", minimum: 1, default: 256, description: "The memory." });
		expect(schema.properties?.net).toEqual({
			type: "string",
			enum: ["switch0", "none"],
			default: "switch0",
			description: "The network.",
		});
	});

	it("requires the command after --", () => {
		expect(toolOf(exec).inputSchema).toMatchObject({
			required: ["targets", "command"],
			properties: { targets: { type: "string" }, command: { type: "string" } },
		});
	});

	it("is an empty object for a verb with no arguments", () => {
		expect(toolOf(ls).inputSchema).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		});
	});

	it("carries the verb's tool name, policy and annotations", () => {
		expect(toolOf(rm)).toMatchObject({
			name: "machines_remove",
			description: "Removes machines and their disks",
			policy: "ask",
			annotations: { consequentialHint: true },
		});
		expect(registry.command(focus).tool).toBeNull();
	});
});

describe("tool input as a bar line", () => {
	it("writes fields as tokens in bar grammar, leaving defaults out", () => {
		const tool = toolOf(spawn);
		expect(tool.toLine({ count: 2, image: "alpine" })).toBe("spawn 2 alpine");
		expect(tool.toLine({ count: 2, image: "alpine", mem: 512, net: "none" })).toBe("spawn 2 alpine --mem 512 --no-net");
		expect(tool.toLine({ count: 2, image: "alpine", net: "switch0" })).toBe("spawn 2 alpine");
		expect(toolOf(exec).toLine({ targets: "all", command: "ping -c1  node3" })).toBe("exec all -- ping -c1  node3");
	});

	it("gives a line that the bar's parser reads back to the same arguments", () => {
		const line = toolOf(spawn).toLine({ count: 3, image: "debian", mem: 128, net: "none" });
		expect(typeof line).toBe("string");
		expect(parsedOk(parseLine(registry, String(line), lab)).args).toEqual({
			count: 3,
			image: "debian",
			mem: 128,
			net: "none",
		});
	});

	it("leaves bad values to the parser, so the agent gets the verb's own sentence", () => {
		const line = toolOf(spawn).toLine({ count: 2, image: "alpne" });
		expect(parseLine(registry, String(line), lab)).toMatchObject({
			message: "No image called alpne. You have alpine, debian. Nothing was changed.",
		});
	});

	it("refuses a field that would smuggle in more tokens or options", () => {
		expect(toolOf(spawn).toLine({ count: 2, image: "alpine --no-net" })).toEqual({
			message: 'image must be one word that does not start with -, not "alpine --no-net". Nothing was changed.',
		});
		expect(toolOf(spawn).toLine({ count: "-1", image: "alpine" })).toMatchObject({
			message: expect.stringContaining("count must be one word"),
		});
		expect(toolOf(exec).toLine({ targets: "all", command: "ls\nrm -rf /" })).toEqual({
			message: "command must be a string on one line. Nothing was changed.",
		});
	});

	it("refuses missing, unknown and non-object input", () => {
		expect(toolOf(spawn).toLine({ image: "alpine" })).toEqual({
			message: "spawn needs the count field, such as 1. Nothing was changed.",
		});
		expect(toolOf(spawn).toLine({ count: 1, image: "alpine", cpu: 2 })).toEqual({
			message: "spawn has no field called cpu, so use count, image, mem or net. Nothing was changed.",
		});
		expect(toolOf(ls).toLine(null)).toEqual({
			message: "ls wants its input as an object of fields, such as {}. Nothing was changed.",
		});
		expect(toolOf(ls).toLine({})).toBe("ls");
	});
});
