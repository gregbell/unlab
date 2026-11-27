// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const MAP = "src/ui/desktop/topology.ts";
const CSS = "src/ui/desktop/topology.css";
const browser = (grep) => ({ kind: "browser", files: ["src/ui/desktop/topology.browser.test.ts"], grep });
const shared = browser("two cabled nodes in one column");
const wraps = browser("names that wrap");
const loops = browser("cabled to itself twice");
const pairs = browser("four cables between one pair");
const crowd = browser("16 machines and eight switches");
const keyboard = browser("can be used by keyboard");
const colour = browser("by more than its colour");

/** The files that draw the map, which `red.mjs` can put back as they were at origin/main. */
export const MAIN = {
	commit: "5a25194",
	files: [MAP, CSS, "src/ui/desktop/desktop.ts", "src/ui/desktop/desktop.css"],
	tests: [browser()],
};

export const BREAKS = [
	{
		name: "a line runs straight from one tile to the other, across the names between",
		file: MAP,
		from: "return `M ${ax} ${ay} H ${x1} C ${mid} ${ay}, ${mid} ${by}, ${x2} ${by} H ${bx}`;",
		to: "return `M ${ax} ${ay} C ${(ax + bx) / 2} ${ay}, ${(ax + bx) / 2} ${by}, ${bx} ${by}`;",
		tests: [wraps, crowd],
	},
	{
		name: "two nodes of one column are joined by a straight line",
		file: MAP,
		from: "return `M ${ax} ${ay} H ${edge} C ${turn} ${ay}, ${turn} ${by}, ${edge} ${by} H ${bx}`;",
		to: "return `M ${ax} ${ay} L ${bx} ${by}`;",
		tests: [shared, crowd],
	},
	{
		name: "a tall name has no more room than a short one",
		file: CSS,
		from: "row-gap: 5px;",
		to: "row-gap: 5px;\n\t\theight: 96px;",
		tests: [wraps],
	},
	{
		name: "a cable from a switch to itself has no room above its tile",
		file: MAP,
		from: "style=${loops ? `padding-top:${LOOP.lift + LOOP.step * (loops - 1) + LOOP.clear}px` : nothing} ",
		to: "",
		tests: [loops],
	},
	{
		name: "every cable from a switch to itself is the one loop",
		file: MAP,
		from: "a.y - (a.half + LOOP.lift + LOOP.step * index) / 0.75,",
		to: "a.y - (a.half + LOOP.lift) / 0.75,",
		tests: [loops],
	},
	{
		name: "the cables between one pair are the one line",
		file: MAP,
		from: "const shift = (index - (of - 1) / 2) * Math.min(8, (a.half * 1.2) / Math.max(1, of - 1));",
		to: "const shift = 0 * index * of;",
		tests: [pairs],
	},
	{
		name: "the lines stay where they were when a node or the window changes size",
		file: MAP,
		from: "new ResizeObserver(() => this.#draw())",
		to: "new ResizeObserver(() => {})",
		tests: [shared, wraps, loops, pairs, crowd],
	},
	{
		name: "a long name is cut short with an ellipsis",
		file: CSS,
		from: "font-size: var(--fs-input);",
		to: "font-size: var(--fs-input);\n\t\tmax-width: 100%;\n\t\toverflow: hidden;\n\t\twhite-space: nowrap;\n\t\ttext-overflow: ellipsis;",
		tests: [wraps, crowd],
	},
	{
		name: "a map taller than its window is centred in it, its top above where scrolling reaches",
		file: CSS,
		from: "place-items: safe center;",
		to: "place-items: center;\n\t\tplace-content: center;",
		tests: [crowd],
	},
	{
		name: "the selected node's frame is as thin as any other's",
		file: CSS,
		from: "box-shadow: inset 0 0 0 1px var(--machine-hue, var(--agent));",
		to: "",
		tests: [colour],
	},
	{
		name: "the selected node's name is as light as any other's",
		file: CSS,
		from: "font-weight: 600;",
		to: "font-weight: 500;",
		tests: [colour],
	},
	{
		name: "a selected node's lines are as thin as the others",
		file: CSS,
		from: "stroke-width: 3;",
		to: "stroke-width: 2;",
		tests: [colour],
	},
	{
		name: "a cut cable is drawn only in red",
		file: CSS,
		from: "stroke-dasharray: 5 5;",
		to: "",
		tests: [colour],
	},
	{
		name: "a blocked cable is drawn as one in use",
		file: CSS,
		from: "stroke-dasharray: 10 3 2 3;",
		to: "",
		tests: [colour],
	},
	{
		name: "a learning port's cable is dashed as a cut one",
		file: CSS,
		from: "stroke-dasharray: 10 3;",
		to: "stroke-dasharray: 5 5;",
		tests: [colour],
	},
	{
		name: "an off machine's cable is drawn as one in use",
		file: CSS,
		from: "stroke-dasharray: 2 4;",
		to: "",
		tests: [colour],
	},
	{
		name: "Tab passes the map's nodes by",
		file: MAP,
		from: '<button class="n-node"',
		to: '<button tabindex="-1" class="n-node"',
		tests: [keyboard],
	},
	{
		name: "Tab goes up each column while the eye goes down it",
		file: CSS,
		from: "justify-content: space-around;",
		to: "justify-content: space-around;\n\t\tflex-direction: column-reverse;",
		tests: [keyboard],
	},
	{
		name: "a node with the focus looks as one without",
		file: CSS,
		from: "cursor: pointer;",
		to: "cursor: pointer;\n\t\toutline: none !important;",
		tests: [keyboard],
	},
	{
		name: "Enter and Space on a node do nothing",
		file: MAP,
		from: "@click=${() => pick(d)}",
		to: "@click=${() => {}}",
		tests: [keyboard],
	},
	{
		name: "no node says that it is the selected one",
		file: MAP,
		from: "aria-pressed=${selected?.name === d.name}",
		to: 'aria-pressed="false"',
		tests: [keyboard, colour],
	},
];
