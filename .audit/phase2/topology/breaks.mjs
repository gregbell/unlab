// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const MAP = "src/ui/desktop/topology.ts";
const CSS = "src/ui/desktop/topology.css";
const DESKTOP = "src/ui/desktop/desktop.ts";
const browser = (grep) => ({ kind: "browser", files: ["src/ui/desktop/topology.browser.test.ts"], grep });
const drawn = browser("draws every switch");
const follows = browser("follows each command");
const keyboard = browser("keyboard");
const names = browser("long names");
const crowd = browser("16 machines");
const page = { kind: "e2e", files: ["e2e/desktop-cables.spec.ts"] };

/** The note at origin/main, which this slice keeps. */
const MAIN_NOTE = `const impaired = edges.some((edge) => edge.conditions && edge.ends.some((end) => end.name === d.name));
			const marked = impaired ? \` · \${IMPAIRED}\` : "";
			const meta =
				d.kind === "switch"
					? \`\${selectPorts(d.name)(lab).filter((port) => port.state !== "empty").length} / 8 ports\${selectStorm(d.name)(lab) ? " · storming" : ""}\${marked}\`
					: \`\${m?.spec.image ?? ""}\${marked}\`;`;

/** The note at 7609dd7: a machine's NIC count, or its one NIC's VLAN, besides its marks. */
const NOTE_7609DD7 = `const sides = sidesAt(edges, d.name);
			const marks = [
				...(d.kind === "switch" && selectStorm(d.name)(lab) ? ["storming"] : []),
				...(sides.some(({ edge }) => edge.conditions) ? [IMPAIRED] : []),
			];
			const nics = m?.spec.nics.length ?? 0;
			const meta = (
				d.kind === "switch"
					? [\`\${selectPorts(d.name)(lab).filter((port) => port.state !== "empty").length} / 8 ports\`, ...marks]
					: [
							m?.spec.image ?? "",
							...(nics > 1 ? [\`\${nics} NICs\`] : sides.flatMap((side) => vlanAt(side)?.tag ?? [])),
							...marks,
						]
			).join(" · ");`;

export const BREAKS = [
	{
		name: "a note says a machine's NICs or VLAN, as at 7609dd7",
		file: MAP,
		from: MAIN_NOTE,
		to: NOTE_7609DD7,
		tests: [names, drawn, follows],
	},
	{
		name: "a node describes none of its cables",
		file: MAP,
		from: 'aria-description=${words.length ? words.join(". ") : nothing} title=${words.length ? words.join("\\n") : nothing}',
		to: "",
		tests: [drawn, follows, keyboard, names, page],
	},
	{
		name: "a node's words name no NIC",
		file: MAP,
		from: "? `${side.end.nic} · to ${side.other.label}`",
		to: "? `to ${side.other.label}`",
		tests: [drawn, follows, names, page],
	},
	{
		name: "a node's words say no VLAN or trunk",
		file: MAP,
		from: "vlanAt(side)?.text,",
		to: "",
		tests: [follows, names, page],
	},
	{
		name: "a node's words say no conditions",
		file: MAP,
		from: "side.edge.conditions,",
		to: "",
		tests: [follows, names],
	},
	{
		name: "the map marks no storm",
		file: MAP,
		from: '${selectStorm(d.name)(lab) ? " · storming" : ""}',
		to: "",
		tests: [follows, crowd, page],
	},
	{
		name: "the map marks no impaired cable",
		file: MAP,
		from: "const marked = impaired ? ` · ${IMPAIRED}` : \"\";",
		to: 'const marked = "";',
		tests: [follows, names, crowd],
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
		tests: [crowd, names],
	},
	{
		name: "a name sits where the lines come in",
		file: CSS,
		from: "top: 100%;",
		to: "top: 30%;",
		tests: [crowd],
	},
];
