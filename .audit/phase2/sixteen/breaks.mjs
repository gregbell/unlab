// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const TYPES = "src/model/types.ts";
const MACHINES = "src/model/machines.ts";
const WORDS = "src/commands/verbs/words.ts";
const LS = "src/commands/verbs/ls.ts";
const RAIL = "src/ui/rail/rail.ts";
const STRIP = "src/ui/parked-strip/parked-strip.ts";
const CAPTURE = "src/ui/capture/capture.ts";
const DESKTOP = "src/ui/desktop/desktop.ts";
const WORKER = "src/runtime/vm-worker.ts";

const model = { kind: "unit", files: ["src/model/machines.test.ts"] };
const saved = { kind: "unit", files: ["src/model/workspace.test.ts"], grep: "sixteen" };
const said = { kind: "unit", files: ["src/commands/refusals.test.ts", "src/commands/verbs/spawn.test.ts"] };
const listed = { kind: "unit", files: ["src/commands/verbs/ls.test.ts"] };
const sentence = { kind: "unit", files: ["src/runtime/shortage.test.ts"] };
const rail = { kind: "browser", files: ["src/ui/rail/rail.browser.test.ts"], grep: "memory" };
const form = { kind: "browser", files: ["src/ui/spawn-form/spawn-form.browser.test.ts"], grep: "full" };
const page = (grep) => ({ kind: "e2e", files: ["e2e/scale.spec.ts"], grep });
const sixteen = page("sixteen machines");
const noMemory = page("no memory");
const desktop = page("desktop");

export const BREAKS = [
	{
		name: "a lab holds eight machines",
		file: TYPES,
		from: "export const MAX_MACHINES = 16;",
		to: "export const MAX_MACHINES = 8;",
		tests: [model, said, sixteen],
	},
	{
		name: "a lab holds seventeen machines",
		file: TYPES,
		from: "export const MAX_MACHINES = 16;",
		to: "export const MAX_MACHINES = 17;",
		tests: [model, said, sixteen],
	},
	{
		name: "a ninth machine takes the first hue, whoever has it",
		file: MACHINES,
		from: "const hue = HUES.reduce((fewest, other) => (holders(other) < holders(fewest) ? other : fewest));",
		to: "const hue = HUES.find((other) => holders(other) === 0) ?? HUES[0];",
		tests: [model],
	},
	{
		name: "a saved lab holds eight machines",
		file: "src/model/workspace.ts",
		from: "saved.nodes.length > MAX_MACHINES) return invalid();",
		to: "saved.nodes.length > HUES.length) return invalid();",
		tests: [saved],
	},
	{
		name: "a saved lab holds any number of machines",
		file: "src/model/workspace.ts",
		from: "saved.nodes.length > MAX_MACHINES) return invalid();",
		to: "saved.nodes.length > 99) return invalid();",
		tests: [saved],
	},
	{
		name: "no two machines of a saved lab have one hue",
		file: "src/model/workspace.ts",
		from: "nodes.some((node) => node.identity.n === id.n || node.identity.name === id.name)",
		to: "nodes.some((node) => node.identity.n === id.n || node.identity.name === id.name || node.hue === hue)",
		tests: [saved],
	},
	{
		name: "a second switch carries nothing",
		file: "src/runtime/fabric.ts",
		from: "\treceive(slot: number, from: PortNo, frame: Uint8Array, now: number): void {\n",
		to: "\treceive(slot: number, from: PortNo, frame: Uint8Array, now: number): void {\n\t\tif (slot > 0) return;\n",
		tests: [sixteen],
	},
	{
		name: "a full lab does not say its limit",
		file: WORDS,
		from: "? `The lab has all ${MAX_MACHINES} machines that it can, so remove one with rm first.`",
		to: '? "The lab has no room for another machine, so remove one with rm first."',
		tests: [said, form, sixteen],
	},
	{
		name: "a lab with room left does not say its limit",
		file: WORDS,
		from: ": `The lab holds ${MAX_MACHINES} machines and has room for ${free} more, not ${wanted}.`;",
		to: ": `The lab has room for ${free} more, not ${wanted}.`;",
		tests: [said],
	},
	{
		name: "the machine list says no memory",
		file: RAIL,
		from: "${this.#memory.value} MiB<span",
		to: "<span",
		tests: [rail, sixteen, noMemory],
	},
	{
		name: "a machine that is off or failed still counts as given its memory",
		file: MACHINES,
		from: 'const RUNS: readonly Phase[] = ["booting", "ready", "stopping"];',
		to: 'const RUNS: readonly Phase[] = ["booting", "ready", "stopping", "off", "failed"];',
		tests: [model, rail, noMemory, desktop],
	},
	{
		name: "the desktop says no memory",
		file: DESKTOP,
		from: '<span title="Memory given to the machines that are running">${icon("memory")}${memoryGiven(ms)} MiB</span>',
		to: "",
		tests: [desktop],
	},
	{
		name: "ls says no memory",
		file: LS,
		from: " · ${memoryGiven(machines)} MiB of memory`;",
		to: "`;",
		tests: [listed, sixteen],
	},
	{
		name: "machines_list has no machine's memory",
		file: LS,
		from: "\t\tmemoryMiB: m.spec.memMiB,\n",
		to: "",
		tests: [listed, sixteen],
	},
	{
		name: "a machine with no memory says what its kernel said",
		file: WORKER,
		from: 'fail(e instanceof BootError && e.stage === "memory" ? memoryShortage(c.name, c.memoryMiB) : reason, true);',
		to: "fail(reason, true);",
		tests: [noMemory],
	},
	{
		name: "the sentence for no memory does not name memory",
		file: "src/runtime/shortage.ts",
		from: "return `The browser could not give ${machine} ${mib} MiB of memory, so remove a machine or close other tabs, then boot it again.`;",
		to: "return `${machine} did not boot, so boot it again.`;",
		tests: [sentence, noMemory],
	},
	{
		name: "a machine that failed keeps its worker",
		file: MACHINES,
		from: '\t\t{ type: "vm/stop", machine: name, attempt, how: "save" },\n\t];\n\tfor (const port of portsOf(life))',
		to: "\t];\n\tfor (const port of portsOf(life))",
		tests: [noMemory],
	},
	{
		name: "the machine list has eight rows",
		file: RAIL,
		from: "\t\t\t\t\t\t\t\trows,\n\t\t\t\t\t\t\t\t(row) => row.name,",
		to: "\t\t\t\t\t\t\t\trows.slice(0, 8),\n\t\t\t\t\t\t\t\t(row) => row.name,",
		tests: [sixteen],
	},
	{
		name: "a parked machine past the eighth has no chip",
		file: STRIP,
		from: "\t\t\t\t\tchips,\n\t\t\t\t\t(name) => name,",
		to: "\t\t\t\t\tchips.slice(0, 8),\n\t\t\t\t\t(name) => name,",
		tests: [sixteen],
	},
	{
		name: "the capture shows a machine by its hue alone",
		file: CAPTURE,
		from: "data-hue=${this.#hue(end) ?? nothing}>${endText(end)}</span>`;",
		to: 'data-hue=${this.#hue(end) ?? nothing}>${named ? "●" : endText(end)}</span>`;',
		tests: [sixteen],
	},
];
