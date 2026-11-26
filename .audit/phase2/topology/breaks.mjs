// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const MAP = "src/ui/desktop/topology.ts";
const CSS = "src/ui/desktop/topology.css";
const DESKTOP = "src/ui/desktop/desktop.ts";
const browser = (grep) => ({ kind: "browser", files: ["src/ui/desktop/topology.browser.test.ts"], grep });
const drawn = browser("draws every switch");
const follows = browser("follows each command");
const keyboard = browser("keyboard");
const crowd = browser("16 machines");
const page = { kind: "e2e", files: ["e2e/desktop-cables.spec.ts"] };

export const BREAKS = [
	{
		name: "the map names no NIC",
		file: MAP,
		from: "...((m?.spec.nics.length ?? 0) > 1",
		to: "...(false",
		tests: [drawn, follows, crowd],
	},
	{
		name: "a node describes none of its cables",
		file: MAP,
		from: 'aria-description=${words.length ? words.join(". ") : nothing} title=${words.length ? words.join("\\n") : nothing}',
		to: "",
		tests: [drawn, keyboard, page],
	},
	{
		name: "the map says no VLAN",
		file: MAP,
		from: "const vlans = [...new Set(sides.flatMap((side) => vlanAt(side)?.tag ?? []))];",
		to: "const vlans: string[] = [];",
		tests: [follows, crowd, page],
	},
	{
		name: "the map marks no storm",
		file: MAP,
		from: '...(d.kind === "switch" && selectStorm(d.name)(lab) ? ["storming"] : []),',
		to: "",
		tests: [follows, crowd, page],
	},
	{
		name: "the desktop draws a port's VLAN at its next tick",
		file: DESKTOP,
		from: "before.portVlans !== next.portVlans ||",
		to: "",
		tests: [follows],
	},
	{
		name: "the desktop draws a moved, cut or impaired cable at its next tick",
		file: DESKTOP,
		from: "before.machines !== next.machines ||",
		to: "",
		tests: [follows],
	},
	{
		name: "a cut cable is drawn only in red",
		file: CSS,
		from: "stroke-dasharray: 5 5;",
		to: "",
		tests: [keyboard],
	},
	{
		name: "Tab passes the map's nodes by",
		file: MAP,
		from: '<button class="n-node"',
		to: '<button tabindex="-1" class="n-node"',
		tests: [keyboard],
	},
	{
		name: "a node with focus looks as one without",
		file: CSS,
		from: "cursor: pointer;",
		to: "cursor: pointer;\n\t\toutline: none !important;",
		tests: [keyboard],
	},
	{
		name: "Enter on a node opens nothing",
		file: MAP,
		from: "@click=${() => pick(d)}",
		to: "@click=${() => {}}",
		tests: [keyboard],
	},
	{
		name: "rows are too close for their names",
		file: MAP,
		from: "height = Math.max(280, rows * 116);",
		to: "height = Math.max(280, rows * 64);",
		tests: [crowd],
	},
	{
		name: "a name sits where the lines come in",
		file: CSS,
		from: "top: 100%;",
		to: "top: 30%;",
		tests: [crowd],
	},
];
