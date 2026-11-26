// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const FABRIC = "src/runtime/fabric.ts";
const fabricUnit = { kind: "unit", files: ["src/runtime/fabric.test.ts"], grep: "VLANs" };
const modelUnit = { kind: "unit", files: ["src/model/vlans.test.ts"] };
const savedUnit = { kind: "unit", files: ["src/commands/saved-labs.test.ts"] };

export const BREAKS = [
	{
		name: "every port carries every VLAN",
		file: FABRIC,
		from: "const carries = (mode: Mode, vlan: number): boolean => (mode.trunk ? allows(mode, vlan) : mode.vlan === vlan);",
		to: "const carries = (_mode: Mode, _vlan: number): boolean => true;",
		tests: [fabricUnit],
	},
	{
		name: "one table for every VLAN",
		file: FABRIC,
		from: "\tconst table = tableOf(sw, vlan);",
		to: "\tconst table = tableOf(sw, 1);",
		tests: [fabricUnit],
	},
	{
		name: "a trunk sends every VLAN untagged",
		file: FABRIC,
		from: "\t\t\tif (!egress.trunk || egress.vlan === vlan) return",
		to: "\t\t\tif (true) return",
		tests: [fabricUnit],
	},
	{
		name: "a trunk allows every VLAN",
		file: FABRIC,
		from: "const allows = ({ allows }: Mode, vlan: number): boolean => allows === null ||",
		to: "const allows = ({ allows }: Mode, vlan: number): boolean => true ||",
		tests: [fabricUnit],
	},
	{
		name: "an untagged frame on a trunk is in VLAN 1",
		file: FABRIC,
		from: "\t\tconst vlan = tag ?? mode.vlan;",
		to: "\t\tconst vlan = tag ?? (mode.trunk ? 1 : mode.vlan);",
		tests: [fabricUnit],
	},
	{
		name: "a port keeps what was learned on it when its VLAN changes",
		file: FABRIC,
		from: "\t\tsw.modes[port] = modeOf(vlan);\n\t\tforget(sw, port);",
		to: "\t\tsw.modes[port] = modeOf(vlan);",
		tests: [fabricUnit],
	},
	{
		name: "an access port on a cable sends tagged",
		file: FABRIC,
		from: "\t\t\tif (!egress.trunk || egress.vlan === vlan) return",
		to: "\t\t\tif (egress.trunk && egress.vlan === vlan) return",
		tests: [fabricUnit],
	},
	{
		name: "a freed port keeps its VLAN",
		file: "src/model/vlans.ts",
		from: "\tconst kept = heldVlans(after, after.portVlans);",
		to: "\tconst kept = after.portVlans;",
		tests: [modelUnit],
	},
	{
		name: "a free port takes a VLAN",
		file: "src/model/vlans.ts",
		from: "\tif (!held || sameVlan(vlanOf(state, port), vlan)) return step(state);",
		to: "\tif (sameVlan(vlanOf(state, port), vlan)) return step(state);",
		tests: [modelUnit],
	},
	{
		name: "a saved lab has no VLANs",
		file: "src/model/workspace.ts",
		from: "\t\tvlans: state.portVlans.map(",
		to: "\t\tvlans: [].map(",
		tests: [modelUnit],
	},
	{
		name: "a reload does not tell the switches",
		file: "src/model/workspace.ts",
		from: "...vlanEffects(state), ",
		to: "",
		tests: [modelUnit],
	},
	{
		name: "version 8 is not upgraded",
		file: "src/model/workspace.ts",
		from: "\t(lab) => ({ ...lab, vlans: [] }),\n",
		to: "",
		tests: [savedUnit],
	},
];
