// The breaks that `red.mjs` makes for story 7.2: a text in a source file, what it becomes, and the tests that must go red.

const BPDU = "src/net/bpdu.ts";
const DECODE = "src/net/decode.ts";
const FILTER = "src/net/filter.ts";
const DETAIL = "src/ui/capture/frame-detail-model.ts";
const RSTP = "src/runtime/rstp.ts";
const FABRIC = "src/runtime/fabric.ts";
const ENGINE = "src/runtime/engine.ts";
const STP = "src/model/stp.ts";
const WORKSPACE = "src/model/workspace.ts";
const TOPOLOGY = "src/commands/verbs/topology.ts";
const PANEL = "src/ui/switch/switch.ts";
const DESKTOP = "src/ui/desktop/desktop.ts";

const unit = (file, grep) => ({ kind: "unit", files: [file], ...(grep ? { grep } : {}) });
const codec = unit("src/net/bpdu.test.ts");
const filter = unit("src/net/filter.test.ts", "protocols");
const inspector = unit("src/ui/capture/frame-detail-model.test.ts", "spanning tree");
const bridge = unit("src/runtime/rstp.test.ts");
const fabric = unit("src/runtime/fabric.test.ts", "spanning tree");
const engine = unit("src/runtime/engine.test.ts", "steered");
const model = unit("src/model/stp.test.ts");
const verbs = { kind: "unit", files: ["src/commands/verbs/stp.test.ts", "src/commands/refusals.test.ts"] };
const saved = unit("src/commands/saved-labs.test.ts", "priority");
const faceplate = { kind: "browser", files: ["src/ui/switch/switch.browser.test.ts"], grep: "spanning tree" };
const kernels = (grep) => ({ kind: "integration", files: ["test/integration/spanning-tree.test.ts"], grep });
const real = { steer: kernels("tcpdump reads the root"), vlans: kernels("one tree covers every VLAN") };
const e2e = (grep) => ({ kind: "e2e", files: ["e2e/spanning-tree-election.spec.ts"], grep });
const page = { classic: e2e("the switches exchange"), desktop: e2e("switch details") };

export const BREAKS = [
	// Box 1: real BPDUs, which the capture decodes and a guest's tcpdump sees.
	{
		name: "the capture reads no BPDU",
		file: DECODE,
		from: '\tif (bpdu) return { proto: bpdu.rapid ? "RSTP" : "STP", src, dst, info: bpduText(bpdu) };',
		to: "",
		tests: [codec, real.steer, page.classic],
	},
	{
		name: "the capture says the sender where the root is",
		file: BPDU,
		from: "\t\t`root ${bridgeText(bpdu.root)}`,",
		to: "\t\t`root ${bridgeText(bpdu.bridge)}`,",
		tests: [codec, page.classic],
	},
	{
		name: "the capture says the cost of no way",
		file: BPDU,
		from: "\t\t`cost ${bpdu.cost}`,",
		to: "\t\t`cost 0`,",
		tests: [codec, real.steer],
	},
	{
		name: "the capture's port is the whole port ID",
		file: BPDU,
		from: "port ${bpdu.port & 0x0fff}`,",
		to: "port ${bpdu.port}`,",
		tests: [codec, real.steer, page.classic],
	},
	{
		name: "the inspector has no group for a BPDU",
		file: DETAIL,
		from: "\tif (bpdu) return [...out, bpduGroup(bpdu)];",
		to: "",
		tests: [inspector],
	},
	{
		name: "stp filters nothing",
		file: FILTER,
		from: '\t["stp", isForBridges],',
		to: '\t["stp", () => false],',
		tests: [filter, page.classic],
	},
	{
		name: "a switch sends no BPDU to a machine",
		file: FABRIC,
		from: "\t\t\t\t\tif (port) this.#send(sw, p, port, frame, now, FRESH);",
		to: "\t\t\t\t\tif (port && port.sink === null) this.#send(sw, p, port, frame, now, FRESH);",
		tests: [real.steer, page.classic],
	},

	// Box 2: each switch shows the root, its own bridge ID, and each port's role and state.
	{
		name: "a switch says only that spanning tree is on",
		file: STP,
		from: '\tif (!reading) return "on";',
		to: '\tif (reading || !reading) return "on";',
		tests: [verbs, faceplate, page.classic, page.desktop],
	},
	{
		name: "the root is never named",
		file: STP,
		from: "\treturn switches.find((name) => trees[name]?.bridge.address === root.address) ?? null;",
		to: "\treturn null;",
		tests: [model, verbs, page.classic, page.desktop],
	},
	{
		name: "a port's role goes unsaid",
		file: STP,
		from: "\treturn [`${port.role} port`, ...(word ? [word] : [])].join(\" · \");",
		to: "\treturn word;",
		tests: [model, verbs, page.desktop],
	},
	{
		name: "topology_read has no tree",
		file: TOPOLOGY,
		from: "\t\t\t\t...(tree ? { tree } : {}),",
		to: "",
		tests: [verbs, page.classic],
	},
	{
		name: "the switch panel says nothing of the tree under its ports",
		file: PANEL,
		from: '${this.#tree.value === null ? nothing : html`<p class="counters">spanning tree ${this.#tree.value}</p>`}',
		to: "",
		tests: [faceplate, page.classic],
	},
	{
		name: "the switch panel's title says no role",
		file: PANEL,
		from: "\t\tconst role = port.tree && `${port.tree.role} port`;",
		to: "\t\tconst role = null;",
		tests: [faceplate, page.classic],
	},
	{
		name: "the desktop's details say on and no more",
		file: DESKTOP,
		from: "<div><dt>Spanning tree</dt><dd>${tree}</dd></div>",
		to: "<div><dt>Spanning tree</dt><dd>on</dd></div>",
		tests: [page.desktop],
	},

	// Box 3: priority and cost, each of which can change the root or the blocked port.
	{
		name: "a bridge does not act on a new priority",
		file: RSTP,
		from: "\t\tthis.#own = vector(id, 0, id, 0);\n\t\tfor (const port of this.#ports) this.#reselect(port);",
		to: "\t\tthis.#own = vector(id, 0, id, 0);",
		tests: [bridge, fabric, engine, real.steer, page.classic],
	},
	{
		name: "a bridge does not act on a new cost",
		file: RSTP,
		from: "\t\tport.cost = cost;\n\t\tthis.#reselect(port);",
		to: "\t\tport.cost = cost;",
		tests: [bridge, fabric, engine, real.steer, page.classic],
	},
	{
		name: "a way to the root costs more than a message can say",
		file: RSTP,
		from: "vector(root, Math.min(cost + port.cost, MOST_COST), bridge, sender)",
		to: "vector(root, cost + port.cost, bridge, sender)",
		tests: [bridge],
	},
	{
		name: "a switch's new tree forgets its ports' costs",
		file: FABRIC,
		from: "\t\t\ttree.setCost(p as PortNo, sw.costs[p]);\n",
		to: "",
		tests: [fabric, page.classic],
	},
	{
		name: "a switch's new tree takes the first priority",
		file: FABRIC,
		from: "\t\t\tsw.priority,\n\t\t);",
		to: "\t\t\tDEFAULT_PRIORITY,\n\t\t);",
		tests: [fabric, engine, page.classic],
	},
	{
		name: "the runtime is not told of a priority",
		file: ENGINE,
		from: "\t\t\t\tfabric.setPriority(switchOf(effect.switch).slot, effect.priority);\n",
		to: "",
		tests: [engine, page.classic, page.desktop],
	},
	{
		name: "a priority that is no step of 4096 is taken",
		file: STP,
		from: "n <= MAX_PRIORITY && n % PRIORITY_STEP === 0",
		to: "n <= MAX_PRIORITY",
		tests: [model, verbs, page.classic],
	},
	{
		name: "a cost of 0 is taken",
		file: STP,
		from: "n >= MIN_COST && n <= MAX_COST",
		to: "n >= 0 && n <= MAX_COST",
		tests: [model, verbs, page.classic],
	},
	{
		name: "a cost stays in a port that nothing is in",
		file: STP,
		from: "\tconst kept = heldCosts(after, after.portCosts);",
		to: "\tconst kept = after.portCosts;",
		tests: [model, verbs],
	},
	{
		name: "a saved lab has no priorities",
		file: WORKSPACE,
		from: "\t\tpriorities: state.priorities,",
		to: "\t\tpriorities: {},",
		tests: [model, page.classic],
	},
	{
		name: "a lab saved at version 11 is not carried over",
		file: WORKSPACE,
		from: "\t(lab) => ({ ...lab, priorities: {}, costs: [] }),",
		to: "\t(lab) => lab,",
		tests: [model, saved],
	},

	// Box 4: one tree covers every VLAN, and works across trunks.
	{
		name: "a blocked port takes in tagged frames",
		file: FABRIC,
		from: "\t\tif (tree && !tree.forwards(from)) {",
		to: "\t\tif (tree && !tree.forwards(from) && tag === null) {",
		tests: [fabric, real.vlans],
	},
	{
		name: "a trunk tags the switches' BPDUs",
		file: FABRIC,
		from: "\t\t\t\t\tif (port) this.#send(sw, p, port, frame, now, FRESH);",
		to: "\t\t\t\t\tif (port) this.#send(sw, p, port, sw.modes[p].trunk ? withTag(frame, 10) : frame, now, FRESH);",
		tests: [fabric, real.vlans],
	},
];
