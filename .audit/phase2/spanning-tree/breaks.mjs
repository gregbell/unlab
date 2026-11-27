// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const BPDU = "src/net/bpdu.ts";
const RSTP = "src/runtime/rstp.ts";
const FABRIC = "src/runtime/fabric.ts";
const PUMP = "src/runtime/pump.ts";
const ENGINE = "src/runtime/engine.ts";
const STP = "src/model/stp.ts";
const WORKSPACE = "src/model/workspace.ts";
const VERB = "src/commands/verbs/stp.ts";
const TOPOLOGY = "src/commands/verbs/topology.ts";
const codecUnit = { kind: "unit", files: ["src/net/bpdu.test.ts"] };
const bridgeUnit = { kind: "unit", files: ["src/runtime/rstp.test.ts"] };
const fabricUnit = { kind: "unit", files: ["src/runtime/fabric.test.ts"], grep: "spanning tree" };
const loopUnit = { kind: "unit", files: ["src/runtime/fabric.test.ts"], grep: "a loop of cables" };
const pumpUnit = { kind: "unit", files: ["src/runtime/pump.test.ts"] };
const engineUnit = { kind: "unit", files: ["src/runtime/engine.test.ts"], grep: "cables between switches" };
const modelUnit = { kind: "unit", files: ["src/model/stp.test.ts"] };
const savedUnit = { kind: "unit", files: ["src/commands/saved-labs.test.ts"] };
const verbUnit = { kind: "unit", files: ["src/commands/verbs/stp.test.ts", "src/commands/refusals.test.ts"] };
const faceplate = { kind: "browser", files: ["src/ui/switch/switch.browser.test.ts"], grep: "spanning tree" };
const map = { kind: "browser", files: ["src/ui/desktop/topology.browser.test.ts"], grep: "spanning tree" };
const kernels = (grep) => ({ kind: "integration", files: ["test/integration/spanning-tree.test.ts"], grep });
const oldKernels = { kind: "integration", files: ["test/integration/switch-cables.test.ts"], grep: "one broadcast goes round" };
const e2e = (grep) => ({ kind: "e2e", files: ["e2e/spanning-tree.spec.ts"], grep });
const real = {
	triangle: kernels("one port blocks"),
	cut: kernels("cutting a cable in use"),
	storm: kernels("during a storm"),
	off: kernels("spanning tree off"),
};
const page = { on: e2e("comes back with a reload"), cut: e2e("cutting a cable in use"), desktop: e2e("the desktop says") };

export const BREAKS = [
	{
		name: "a message's flags are one bit to the left",
		file: BPDU,
		from: "(bpdu.topologyChange ? 0x01 : 0) |",
		to: "(bpdu.topologyChange ? 0x02 : 0) |",
		tests: [codecUnit],
	},
	{
		name: "a message is read whatever header it is in",
		file: BPDU,
		from: "if (LLC.some((byte, i) => frame[ETH_HDR + i] !== byte) || at(frame, BPDU, 2) !== 0) return null;",
		to: "",
		tests: [codecUnit],
	},
	{
		name: "a port forwards from when its link comes up",
		file: RSTP,
		from: "		port.enabled = true;\n		port.adminEdge = edge;",
		to: "		port.enabled = true;\n		port.learn = port.forward = true;\n		port.adminEdge = edge;",
		tests: [bridgeUnit],
	},
	{
		name: "a port that is a spare goes on forwarding",
		file: RSTP,
		from: "			} else if (port.role !== \"designated\") {\n				port.learn = port.forward = false;",
		to: "			} else if (port.role !== \"designated\") {",
		tests: [bridgeUnit, fabricUnit, real.cut, page.on],
	},
	{
		name: "a designated port forwards without its neighbour's agreement",
		file: RSTP,
		from: "(port.forwardAt <= now || port.agreed || port.edge) && (port.recentRootAt <= now || !port.reRoot) && !port.sync;",
		to: "(port.recentRootAt <= now || !port.reRoot) && !port.sync;",
		tests: [bridgeUnit, fabricUnit],
	},
	{
		name: "a bridge takes the higher address for its root",
		file: RSTP,
		from: "if (through.key < best.key) {",
		to: "if (through.key > best.key) {",
		tests: [bridgeUnit],
	},
	{
		name: "a port never takes its cable to end at no bridge",
		file: RSTP,
		from: "		if (port.edgeAt > this.#now) return false;\n		port.edge = true;",
		to: "		if (port.edgeAt > this.#now || port.edge === false) return false;\n		port.edge = true;",
		tests: [bridgeUnit, fabricUnit, real.off, page.cut],
	},
	{
		name: "what a port heard never runs out",
		file: RSTP,
		from: 'if (port.infoIs === "received" && port.infoAt <= now && !port.updtInfo) {',
		to: 'if (port.infoIs === "received" && port.infoAt < 0 && !port.updtInfo) {',
		tests: [bridgeUnit],
	},
	{
		name: "a change of topology has no port forget",
		file: RSTP,
		from: "				this.#sayChange(port);\n				this.#wire.flush(port.no as PortNo);",
		to: "				this.#sayChange(port);",
		tests: [bridgeUnit, fabricUnit, real.cut],
	},
	{
		name: "a port sends six messages a second, as the standard has it",
		file: RSTP,
		from: "export const TX_HOLD = 1000;",
		to: "export const TX_HOLD = 6;",
		tests: [bridgeUnit],
	},
	{
		name: "a port takes an agreement whatever root it names",
		file: RSTP,
		from: "const answers = message.agreement && said.root === port.held.root;",
		to: "const answers = message.agreement;",
		tests: [bridgeUnit],
	},
	{
		name: "a port sends as often as it has something to say",
		file: RSTP,
		from: "if (!port.newInfo || !port.selected || port.updtInfo || port.sent >= TX_HOLD) return;",
		to: "if (!port.newInfo || !port.selected || port.updtInfo) return;",
		tests: [bridgeUnit],
	},
	{
		name: "a designated port says nothing at a hello",
		file: RSTP,
		from: 'port.newInfo ||= port.role === "designated" || (port.role === "root" && port.changeAt > now);',
		to: 'port.newInfo ||= port.role === "root" && port.changeAt > now;',
		tests: [bridgeUnit],
	},
	{
		name: "a root port waits for its timers when it takes over",
		file: RSTP,
		from: "const may = port.forwardAt <= now || (reRooted && port.recentBackupAt <= now);",
		to: "const may = port.forwardAt <= now || (reRooted && port.recentBackupAt < 0);",
		tests: [bridgeUnit, fabricUnit, real.cut, page.cut],
	},
	{
		name: "a new switch takes part in a spanning tree",
		file: FABRIC,
		from: "		this.#switches[slot] = new Switch();\n		return slot;",
		to: "		this.#switches[slot] = new Switch();\n		this.setTree(slot, { address: 0x0200_0000_0001 + slot });\n		return slot;",
		tests: [fabricUnit, loopUnit, oldKernels, page.on],
	},
	{
		name: "a blocked port goes on taking frames",
		file: FABRIC,
		from: "if (tree && !tree.forwards(from)) {",
		to: "if (tree && !tree.forwards(from) && from === 0) {",
		tests: [fabricUnit, real.triangle, real.storm, page.on],
	},
	{
		name: "a blocked port goes on sending frames",
		file: FABRIC,
		from: "if (!carries(egress, vlan) || (tree && !tree.forwards(p))) return false;",
		to: "if (!carries(egress, vlan)) return false;",
		tests: [fabricUnit, real.triangle, real.storm, page.on],
	},
	{
		name: "the tree's messages are put on no cable",
		file: FABRIC,
		from: "if (port) this.#send(sw, p, port, frame, now, FRESH);",
		to: "if (port && p === 0) this.#send(sw, p, port, frame, now, FRESH);",
		tests: [fabricUnit, pumpUnit, engineUnit, real.triangle, page.on],
	},
	{
		name: "a switch with spanning tree off sends the tree's messages on",
		file: FABRIC,
		from: "if (frame[0] & 1 && macAt(frame, 0) === BRIDGE_GROUP) {",
		to: "if (sw.tree && frame[0] & 1 && macAt(frame, 0) === BRIDGE_GROUP) {",
		tests: [fabricUnit, real.off, page.cut],
	},
	{
		name: "a cut is not told to the tree",
		file: FABRIC,
		from: "			else sw.tree?.disable(port as PortNo);\n",
		to: "",
		tests: [fabricUnit, real.cut, page.cut],
	},
	{
		name: "a switch that begins keeps what it had learned",
		file: FABRIC,
		from: "		sw.treeTold = 0;\n		sw.tables.clear();",
		to: "		sw.treeTold = 0;",
		tests: [fabricUnit],
	},
	{
		name: "the tree's messages are read after a frame is put in a VLAN",
		file: FABRIC,
		from: "		if (frame[0] & 1 && macAt(frame, 0) === BRIDGE_GROUP) {\n			this.#toBridge(sw, slot, from as PortNo, src, frame, now);\n			return;\n		}\n",
		to: "",
		tests: [fabricUnit],
	},
	{
		name: "the owner is told of a tree at every run",
		file: FABRIC,
		from: "		if (tree.version === sw.treeTold) return;\n",
		to: "",
		tests: [fabricUnit],
	},
	{
		name: "the pump takes a hello's wait in steps",
		file: PUMP,
		from: "const wait = Math.min(until(timer), at < 0 ? Number.POSITIVE_INFINITY : Math.min(STEP_MS, until(at)));",
		to: "const wait = Math.min(STEP_MS, until(timer), until(at));",
		tests: [pumpUnit],
	},
	{
		name: "the pump sets no timer for the tree",
		file: PUMP,
		from: "const timer = fabric.timer();",
		to: "const timer = -1;",
		tests: [pumpUnit, engineUnit, real.off],
	},
	{
		name: "the fabric is not drained when it is told of a tree",
		file: ENGINE,
		from: "		if (fabric.busy) pump.wake();\n",
		to: "",
		tests: [engineUnit],
	},
	{
		name: "the store is not told of a switch's part in the tree",
		file: ENGINE,
		from: 'if (name) dispatch({ type: "switch/tree", switch: name, tree });',
		to: "",
		tests: [engineUnit, page.on, page.desktop],
	},
	{
		name: "the runtime is not told that a switch takes part",
		file: "src/model/update.ts",
		from: "...vlans.effects, ...stp.effects, ...settleConditions(before, state)];",
		to: "...vlans.effects, ...settleConditions(before, state)];",
		tests: [modelUnit, verbUnit, page.on],
	},
	{
		name: "a switch that is removed keeps its setting",
		file: STP,
		from: "const kept = after.stp.filter((name) => after.switches.includes(name));",
		to: "const kept = after.stp;",
		tests: [modelUnit],
	},
	{
		name: "a reading is kept of a switch that takes no part",
		file: STP,
		from: "if (!stpOn(state, name) || !state.switches.includes(name)) return step(state);",
		to: "if (!state.switches.includes(name)) return step(state);",
		tests: [modelUnit],
	},
	{
		name: "a saved lab has no spanning tree",
		file: WORKSPACE,
		from: "		stp: state.stp,\n",
		to: "		stp: [],\n",
		tests: [modelUnit, page.on],
	},
	{
		name: "a reload does not tell the switches",
		file: WORKSPACE,
		from: "		...stpEffects(wired),\n",
		to: "",
		tests: [modelUnit, page.on],
	},
	{
		name: "version 10 is not upgraded",
		file: WORKSPACE,
		from: "	// No switch took part in a spanning tree.\n	(lab) => ({ ...lab, stp: [] }),\n",
		to: "",
		tests: [savedUnit],
	},
	{
		name: "a saved lab may name a switch that is not there",
		file: WORKSPACE,
		from: "const names = saved.map((name: unknown) => readSwitch(name, switches));",
		to: "const names = saved;",
		tests: [modelUnit],
	},
	{
		name: "stp off turns it on",
		file: VERB,
		from: 'const on = a.stp === "on";',
		to: "const on = true;",
		tests: [verbUnit, page.cut],
	},
	{
		name: "stp acts on every switch, whichever it is given",
		file: "src/commands/grammar/slots.ts",
		from: "return { switches: lab.switches.filter((name) => named.has(name)), written: text };",
		to: "return { switches: lab.switches, written: text };",
		tests: [verbUnit, page.cut],
	},
	{
		name: "stp takes a switch that is not there",
		file: "src/commands/grammar/slots.ts",
		from: 'return new Miss(`No switch is called ${part}, so use ${list([...lab.switches, ALL_MACHINES], "or")}.`, span);',
		to: "continue;",
		tests: [verbUnit, page.on],
	},
	{
		name: "topology says nothing of a port's part in the tree",
		file: TOPOLOGY,
		from: "...(tree ? { stp: { role: tree.role, state: tree.state } } : {}),",
		to: "",
		tests: [verbUnit, page.on],
	},
	{
		name: "topology has no word for a blocked port",
		file: TOPOLOGY,
		from: "const tree = treeWord(stp);",
		to: "const tree = treeWord(undefined);",
		tests: [verbUnit, page.on],
	},
	{
		name: "topology does not say which switches take part",
		file: TOPOLOGY,
		from: '...(stpOn(lab, name) ? { stp: "on" as const } : {}),',
		to: "",
		tests: [verbUnit, page.on],
	},
	{
		name: "a port's view has no part in the tree",
		file: "src/model/selectors.ts",
		from: "return { ...view, ...(vlan ? { vlan } : {}), ...(tree ? { tree } : {}) };",
		to: "return { ...view, ...(vlan ? { vlan } : {}) };",
		tests: [faceplate, map, page.on, page.desktop],
	},
	{
		name: "the faceplate's tag says nothing of a blocked port",
		file: "src/ui/switch/switch.ts",
		from: "const tag = [held.nic, port.vlan?.tag, port.conditions && IMPAIRED, treeWord(port.tree)].filter(Boolean).join(\" \");",
		to: "const tag = [held.nic, port.vlan?.tag, port.conditions && IMPAIRED].filter(Boolean).join(\" \");",
		tests: [faceplate, page.on],
	},
	{
		name: "the faceplate's title says nothing of a blocked port",
		file: "src/ui/switch/switch.ts",
		from: "const title = [held.label, treeText(port.tree), port.vlan?.text, port.conditions, ...carried]",
		to: "const title = [held.label, port.vlan?.text, port.conditions, ...carried]",
		tests: [faceplate, page.on],
	},
	{
		name: "a node's words say nothing of a blocked port",
		file: "src/ui/desktop/topology.ts",
		from: "		portAt(side).tree,\n",
		to: "",
		tests: [map, page.desktop],
	},
	{
		name: "the map's line is as it was for a cable with a blocked end",
		file: "src/ui/desktop/topology.ts",
		from: 'const state = (edge.link === "up" && edge.ends.find((end) => end.tree)?.tree) || edge.link;',
		to: "const state = edge.link;",
		tests: [map, page.desktop],
	},
	{
		name: "the desktop's port table says nothing of a blocked port",
		file: "src/ui/desktop/desktop.ts",
		from: '<td data-state=${p.state}>${line ? [p.state, treeWord(p.tree)].filter(Boolean).join(" · ") : "—"}</td>',
		to: '<td data-state=${p.state}>${line ? p.state : "—"}</td>',
		tests: [page.desktop],
	},
	{
		name: "the rack's row says nothing of a blocked port",
		file: "src/ui/desktop/desktop.ts",
		from: "const said = [p.state, treeWord(p.tree), p.conditions].filter(Boolean);",
		to: "const said = [p.state, p.conditions].filter(Boolean);",
		tests: [page.desktop],
	},
	{
		name: "a switch's details do not say that it takes part",
		file: "src/ui/desktop/desktop.ts",
		from: "${stpOn(this.lab, name) ? html`<div><dt>Spanning tree</dt><dd>on</dd></div>` : nothing}</dl>",
		to: "</dl>",
		tests: [page.desktop],
	},
	{
		name: "the desktop draws a tree's reading at its next tick",
		file: "src/ui/desktop/desktop.ts",
		from: "				before.trees !== next.trees ||\n",
		to: "",
		tests: [map],
	},
];
