// The breaks that `red.mjs` makes for the gate and the final check of 1.1, 1.2, 8.1 and 8.2: a text in a source
// file, what it becomes, and the tests that must go red.

const FABRIC = "src/runtime/fabric.ts";
const ENGINE = "src/runtime/engine.ts";
const WORKSPACE = "src/model/workspace.ts";
const CONDITIONS = "src/model/conditions.ts";
const VLANS = "src/model/vlans.ts";
const STP = "src/model/stp.ts";
const TOPOLOGY = "src/commands/verbs/topology.ts";
const SLOTS = "src/commands/grammar/slots.ts";
const TOOLS = "src/agent/tools.ts";

const recorded = { kind: "unit", files: ["src/commands/scenario.test.ts"] };
const kernels = (grep) => ({ kind: "integration", files: ["test/integration/scenario.test.ts"], ...(grep ? { grep } : {}) });
const page = { kind: "e2e", files: ["e2e/gate.spec.ts"] };
const readme = { kind: "e2e", files: ["e2e/readme.spec.ts"] };
const refusals = { kind: "unit", files: ["src/commands/refusals.test.ts"], grep: "names a value" };
const described = { kind: "unit", files: ["src/agent/agent.test.ts"], grep: "capture_read each filter term" };

export const BREAKS = [
	// Story 0, boxes 1 to 4.
	{
		name: "a trunk sends every VLAN untagged",
		file: FABRIC,
		from: "\t\t\tconst untagged = !egress.trunk || egress.vlan === vlan;",
		to: "\t\t\tconst untagged = true;",
		tests: [kernels(), page],
	},
	{
		name: "the model does not tell the switch a port's VLAN",
		file: VLANS,
		from: "\t\tif (!sameVlan(was, vlan)) effects.push({ type: \"port/vlan\", port, vlan });",
		to: "",
		tests: [recorded, kernels(), page],
	},
	{
		name: "the engine does not tell the fabric a port's VLAN",
		file: ENGINE,
		from: "\t\t\t\tfabric.setVlan(switchOf(effect.port.switch).slot, effect.port.port, effect.vlan);",
		to: "",
		tests: [kernels(), page],
	},
	{
		name: "a cable loses no frame below 100%",
		file: FABRIC,
		from: "\t\t\tif (wear.loss > 0 && dir.lost() < wear.loss) {",
		to: "\t\t\tif (wear.loss >= 1 && dir.lost() < wear.loss) {",
		tests: [kernels(), page],
	},
	{
		name: "a cable that loses everything delivers some",
		file: FABRIC,
		from: "\t\t\tif (wear.loss > 0 && dir.lost() < wear.loss) {",
		to: "\t\t\tif (wear.loss > 0 && dir.lost() < wear.loss * 0.5) {",
		tests: [kernels("100%"), page],
	},
	{
		name: "a saved lab keeps no VLANs",
		file: WORKSPACE,
		from: "\t\tvlans: state.portVlans.map(({ port, vlan }) =>",
		to: "\t\tvlans: state.portVlans.slice(0, 0).map(({ port, vlan }) =>",
		tests: [kernels("reload"), page],
	},
	{
		name: "a reload does not tell the switches of a cable's conditions",
		file: CONDITIONS,
		from: "\treturn impaired(state).map(({ port, conditions }) => ({ type: \"port/conditions\", port, conditions }));",
		to: "\treturn [];",
		tests: [kernels("reload")],
	},
	// Story 8.1: spanning tree settings, which the gate's reload holds too.
	{
		name: "a saved lab keeps no priority",
		file: WORKSPACE,
		from: "\t\tpriorities: state.priorities,",
		to: "\t\tpriorities: {},",
		// The test of 1.2 sets the priority that the reload must keep, so the whole file runs.
		tests: [kernels(), page],
	},
	// Story 1.2.
	{
		name: "topology's line for a port says nothing of its cable's conditions",
		file: TOPOLOGY,
		from: "\treturn [...conditionWords(conditions), ...carriedWords(carried)];",
		to: "\treturn [...carriedWords(carried)];",
		tests: [recorded, kernels("topology lists")],
	},
	{
		name: "topology's line for a port says nothing of blocked",
		file: STP,
		from: "\treturn [`${port.role} port`, ...(word ? [word] : [])].join(\" · \");",
		to: "\treturn `${port.role} port`;",
		tests: [kernels("topology lists")],
	},
	// Story 1.1.
	{
		name: "a VLAN that cannot be names neither itself nor what would do",
		file: SLOTS,
		from: "const noVlan = (text: string): string => `${text} is no VLAN, so use one from ${MIN_VLAN} to ${MAX_VLAN}.`;",
		to: "const noVlan = (_text: string): string => `That is no VLAN.`;",
		tests: [refusals],
	},
	{
		name: "capture_read says nothing of the stp filter",
		file: TOOLS,
		from: ", vlan 10 what was in VLAN 10, and stp the spanning tree's messages. Frames come",
		to: ", and vlan 10 what was in VLAN 10. Frames come",
		tests: [described],
	},
	// Story 8.2.
	{
		name: "a cut cable carries on",
		file: ENGINE,
		from: "\t\t\t\tfabric.setLink(switchOf(port.switch).slot, port.port, up);",
		to: "\t\t\t\tfabric.setLink(switchOf(port.switch).slot, port.port, true);",
		tests: [readme],
	},
];
