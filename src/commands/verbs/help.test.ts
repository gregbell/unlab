import { describe, expect, it } from "vitest";
import { completeLine, type JsonSchema, type ToolFace } from "../index.ts";
import { storeLab } from "../testing/store.ts";

const lab = storeLab();
const commands = lab.registry.commands;

async function help(line: string) {
	const result = await lab.run(line);
	if (result.kind !== "report") throw new Error("help reports");
	return result;
}

function toolOf(verb: string): ToolFace | null {
	return lab.registry.find(verb)?.tool ?? null;
}

const fields = (tool: ToolFace): Readonly<Record<string, JsonSchema>> => tool.inputSchema.properties ?? {};

describe("help", () => {
	it("lists every verb with one line each, and the bar stays open on it", async () => {
		const { header, rows, data, blocks } = await help("help");
		expect(header).toBe(`${commands.length} verbs`);
		expect(rows).toEqual(commands.map(({ name, about }) => ({ term: name, text: about })));
		for (const { text } of rows ?? []) expect(text).toMatch(/^[^\n]{5,60}$/);
		expect(data).toEqual(commands.map(({ name, about, tool }) => ({ verb: name, about, tool: tool?.name ?? null })));
		expect(blocks).toEqual([]);
	});

	it("explains spawn: what it does, each argument as it is typed, one example and its tool", async () => {
		const { header, rows } = await help("help spawn");
		expect(header).toBe(`spawn ${lab.registry.find("spawn")?.signature.join(" ")}`);
		expect(rows?.map(({ term }) => term)).toEqual([
			"does",
			"<count>",
			"<image>",
			"[--mem MiB]",
			"[--cpus CPUs]",
			"[--disk 4 | 8 | 16 | 32 | 64]",
			"[--extra-disk GiB,...]",
			"[--name name]",
			"[--nics NICs]",
			"[--net network,... | --no-net]",
			"[--addr address,...]",
			"[--no-gateway]",
			"example",
			"agent tool",
		]);
		const text = (term: string) => rows?.find((row) => row.term === term)?.text;
		expect(text("[--mem MiB]")).toBe("The memory of each machine, in MiB, up to 4096. Left out, 256.");
		expect(text("[--extra-disk GiB,...]")).toContain("/dev/wdc and on");
		expect(text("<image>")).toContain("lab: Alpine with");
		expect(text("example")).toBe("spawn 1 lab --extra-disk 1 --name router --nics 2 --addr 10.1.0.1/24,10.2.0.1/24");
		expect(text("agent tool")).toBe("machines_spawn");
	});

	it("gives an agent each argument under its field and as it is typed, and the example as an input", async () => {
		const { data } = await help("help machines_spawn");
		expect(data).toEqual((await help("help spawn")).data);
		expect(data).toMatchObject({
			verb: "spawn",
			tool: "machines_spawn",
			arguments: expect.arrayContaining([
				expect.objectContaining({ field: "extraDisk", written: "[--extra-disk GiB,...]", required: false }),
				expect.objectContaining({ field: "gateway", written: "[--no-gateway]", required: false }),
				expect.objectContaining({ field: "count", written: "<count>", required: true }),
			]),
			example: { input: { count: 1, image: "lab", nics: 2, extraDisk: "1" } },
		});
	});

	it("explains a verb that has no tool", async () => {
		const { rows, data } = await help("help sh");
		expect(rows?.map(({ term }) => term)).toEqual(["does", "<machine>", "example"]);
		expect(data).toMatchObject({ verb: "sh", tool: null });
	});

	it.each(commands.map(({ name }) => name))("says of %s what its tool and schema say", async (verb) => {
		const { rows = [], data } = await help(`help ${verb}`);
		const command = lab.registry.find(verb);
		if (!command) throw new Error(verb);
		expect(rows[0]).toEqual({ term: "does", text: command.manual.description });
		const args = rows.slice(1, 1 + command.signature.length);
		expect(args.map(({ term }) => term)).toEqual(command.signature);
		expect(rows.at(1 + args.length)).toEqual({ term: "example", text: command.manual.example.line });

		const tool = toolOf(verb);
		if (tool === null) return;
		expect(tool.description).toBe(rows[0].text);
		const { arguments: manual } = command.manual;
		expect(data).toMatchObject({ tool: tool.name });
		expect(Object.keys(fields(tool))).toEqual(manual.map(({ field }) => field));
		expect(tool.inputSchema.required).toEqual(manual.filter((a) => a.required).map((a) => a.field));
		manual.forEach(({ field, about, default: left }, i) => {
			const schema = fields(tool)[field];
			expect(about).not.toBe("");
			expect(schema.description).toBe(about);
			expect(args[i].text).toBe(left === null ? about : `${about} Left out, ${left}.`);
			if (left !== null) expect(String(schema.default)).toBe(left);
		});
	});

	it.each([
		["spawn", "nics", "--nics"],
		["spawn", "net", "--net"],
		["spawn", "net", "--no-net"],
		["spawn", "addr", "--addr"],
		["spawn", "gateway", "--no-gateway"],
		["spawn", "name", "--name"],
		["spawn", "extraDisk", "--extra-disk"],
		["write", "owner", "--owner"],
		["write", "mode", "--mode"],
	])("has %s's %s option in its help and in its tool", async (verb, field, flag) => {
		const { rows = [] } = await help(`help ${verb}`);
		expect(rows.some(({ term }) => term.startsWith("[") && term.split(/[[\]\s]+/).includes(flag))).toBe(true);
		const tool = toolOf(verb);
		expect(tool && fields(tool)[field]?.description).toBeTruthy();
	});

	it.each([
		["spawn", "image", "lab"],
		["link", "machines", "node2:eth1"],
		["capture", "filter", "node2:eth1"],
	])("says what %s's %s can be", async (verb, field, value) => {
		const argument = lab.registry.find(verb)?.manual.arguments.find((a) => a.field === field);
		expect(argument?.about).toContain(value);
	});

	it("completes verbs, previews, and takes a misspelt one as a typo", () => {
		const at = (line: string) => completeLine(lab.registry, line, line.length, lab.store.state);
		expect(at("help ").suggestions.map((s) => s.insert)).toEqual(commands.map((c) => c.name));
		expect(at("help re")).toMatchObject({ slot: 0, suggestions: [{ insert: "reboot" }, { insert: "restore" }] });
		expect(at("help spawn ").suggestions).toEqual([]);
		expect(lab.parsed("help").preview(lab.store.state)).toMatchObject({ will: "list every verb" });
		expect(lab.parsed("help spawn").preview(lab.store.state)).toMatchObject({ will: "explain spawn" });
		expect(lab.parsed("help machines_spawn").line).toBe("help spawn");
		expect(lab.parse("help spwan")).toMatchObject({ token: 1, fix: "help spawn" });
	});
});

describe("capabilities", () => {
	/** They move a person's keyboard or view. An agent reads a terminal with shell_read and the capture with capture_read. */
	const FOR_A_PERSON = ["sh", "capture", "focus"];

	it("gives each verb a tool, but for those that only move what a person sees", () => {
		expect(commands.filter(({ tool }) => tool === null).map(({ name }) => name)).toEqual(FOR_A_PERSON);
		expect(commands.filter(({ tool, manual }) => manual.tool !== (tool?.name ?? null))).toEqual([]);
	});

	it.each(commands.filter(({ tool }) => tool !== null))(
		"runs $name's tool as the line that its help shows",
		(command) => {
			const { example } = command.manual;
			expect(command.tool?.toLine(example.input)).toBe(example.line);
			expect(example.line.split(" ")[0]).toBe(command.name);
		},
	);
});
