// The breaks that `red.mjs` makes for the agent-reach box of story 1.1: a text in a source file, what it becomes, and
// the tests that must go red.

const MACS = "src/commands/verbs/macs.ts";
const PCAP = "src/commands/verbs/pcap.ts";
const FILE = "src/net/pcap.ts";
const PANEL = "src/ui/capture/capture.ts";

const unit = (file, grep) => ({ kind: "unit", files: [file], ...(grep ? { grep } : {}) });
const browser = (file, grep) => ({ kind: "browser", files: [file], ...(grep ? { grep } : {}) });
const macsVerb = unit("src/commands/verbs/macs.test.ts");
const pcapVerb = unit("src/commands/verbs/pcap.test.ts");
const registry = unit("src/commands/verbs/index.test.ts", "tools with their policies");
const besidePanel = browser("src/ui/switch/macs.browser.test.ts");
const besideSave = browser("src/ui/capture/pcap.browser.test.ts");
const saveButton = browser("src/ui/capture/capture.browser.test.ts", "saves");
const link = { kind: "integration", files: ["test/integration/cli-mcp.test.ts"], grep: "as large as capture_save" };
const e2e = (file, grep) => ({ kind: "e2e", files: [file], grep });
const switches = e2e("e2e/switches.spec.ts", "own MAC table");
const cable = e2e("e2e/capture.spec.ts", "narrowed to one cable");

export const BREAKS = [
	// The MAC table and counters, as the switch panel shows them.
	{
		name: "macs reads its ages off the lab's clock, not the switches'",
		file: MACS,
		from: "\t\tconst now = deps.switches.now();",
		to: "\t\tconst now = deps.now();",
		tests: [besidePanel],
	},
	{
		name: "macs reports every switch whichever is named",
		file: MACS,
		from: "\tplan: (a, lab) => ({ switches: a.switches?.switches ?? lab.switches }),",
		to: "\tplan: (_a, lab) => ({ switches: lab.switches }),",
		tests: [besidePanel, switches],
	},
	{
		name: "switch_macs gives every address VLAN 1",
		file: MACS,
		from: "\treturn { mac, port, vlan, ...whose, age, flushed };",
		to: "\treturn { mac, port, vlan: 1, ...whose, age, flushed };",
		tests: [besidePanel],
	},
	{
		name: "macs words its counters its own way",
		file: MACS,
		from: '\t\t\treturn { term: name, text: [totalsText(counters), ...lines].join("\\n") };',
		to: '\t\t\treturn { term: name, text: [`${counters.in} frames`, ...lines].join("\\n") };',
		tests: [besidePanel, macsVerb],
	},
	{
		name: "macs counts flushed addresses as learned",
		file: MACS,
		from: "\t\tconst learned = tables.flatMap(({ rows }) => rows).filter(({ flushed }) => !flushed).length;",
		to: "\t\tconst learned = tables.flatMap(({ rows }) => rows).length;",
		tests: [besidePanel],
	},
	{
		name: "switch_macs is not read-only",
		file: MACS,
		from: '\t\tname: "switch_macs",\n\t\ttitle: "Read switches\' MAC tables",\n\t\tpolicy: "run",\n\t\tannotations: { readOnlyHint: true },',
		to: '\t\tname: "switch_macs",\n\t\ttitle: "Read switches\' MAC tables",\n\t\tpolicy: "run",',
		tests: [registry],
	},
	// The .pcap, as save .pcap makes it.
	{
		name: "a narrowed capture saves every frame, so one cable's file has frames that never crossed it",
		file: FILE,
		from: "\tconst saved = [...wired(narrows(filter) ? matching(frames, filter) : frames, places)];",
		to: "\tconst saved = [...wired(frames, places)];",
		tests: [pcapVerb, saveButton, cable],
	},
	{
		name: "pcap saves the frames newest first",
		file: PCAP,
		from: "\t\tconst file = pcapOf(deps.capture.frames(), filter, switches, deps.capture.startedAt);",
		to: "\t\tconst file = pcapOf([...deps.capture.frames()].reverse(), filter, switches, deps.capture.startedAt);",
		tests: [pcapVerb, besideSave],
	},
	{
		name: "pcap stamps its frames from the lab's clock at the moment it runs",
		file: PCAP,
		from: "\t\tconst file = pcapOf(deps.capture.frames(), filter, switches, deps.capture.startedAt);",
		to: "\t\tconst file = pcapOf(deps.capture.frames(), filter, switches, Date.now() - deps.now());",
		tests: [besideSave],
	},
	{
		name: "save .pcap stamps its frames from the lab's last tick, as it did before",
		file: PANEL,
		from: "\t\tconst file = pcapOf(capture.frames(), capture.filter, this.#switches.value, capture.startedAt);",
		to: "\t\tconst file = pcapOf(capture.frames(), capture.filter, this.#switches.value, Date.now() - this.app.store.state.now);",
		tests: [besideSave, cable],
	},
	{
		name: "a person's pcap downloads nothing",
		file: PCAP,
		from: "\t\t\tdeps.download(file.name, PCAP_TYPE, file.bytes);",
		to: "",
		tests: [pcapVerb, besideSave],
	},
	{
		name: "capture_save returns no bytes",
		file: PCAP,
		from: "data: { ...data, bytes: base64(file.bytes) } };",
		to: "data };",
		tests: [pcapVerb, besideSave],
	},
	{
		name: "base64 leaves out the last part of the file",
		file: PCAP,
		from: "\tfor (let at = 0; at < bytes.length; at += 0x8000)",
		to: "\tfor (let at = 0; at + 0x8000 < bytes.length; at += 0x8000)",
		tests: [pcapVerb, besideSave],
	},
	{
		name: "an agent is given a file of any size",
		file: PCAP,
		from: "\t\tif (file.bytes.length > MAX_PCAP_BYTES) {",
		to: "\t\tif (file.bytes.length > Number.POSITIVE_INFINITY) {",
		tests: [pcapVerb],
	},
	{
		name: "capture_save returns up to 4 MiB, more than the CLI's link takes in one message",
		file: PCAP,
		from: "export const MAX_PCAP_BYTES = 2 * 2 ** 20;",
		to: "export const MAX_PCAP_BYTES = 4 * 2 ** 20;",
		tests: [link],
	},
	{
		name: "capture_save is not marked as reading untrusted content",
		file: PCAP,
		from: "\t\tannotations: { readOnlyHint: true, untrustedContentHint: true },",
		to: "\t\tannotations: { readOnlyHint: true },",
		tests: [registry],
	},
];
