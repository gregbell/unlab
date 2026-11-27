import "./topology.css";
import { html, nothing, svg } from "lit";
import {
	IMPAIRED,
	type LabState,
	type MachineName,
	type PortHolder,
	type PortNo,
	type PortRef,
	type PortVlanView,
	type SwitchName,
	selectPorts,
	selectStorm,
	treeWord,
} from "../../model/index.ts";
import { type NicName, nicName } from "../../net/index.ts";
import { UnlabElement } from "../base/index.ts";

export type Device = { kind: "switch"; name: SwitchName } | { kind: "machine"; name: MachineName };
export type Selection = Device | { kind: "port"; name: SwitchName; port: PortNo };
export const art = (kind: Device["kind"]) => html`<span aria-hidden="true" class="n-art ${kind}"><i></i><b></b></span>`;

/** A drawn line's end: a switch at one of its ports, or a machine at one of its NICs. */
interface End {
	name: string;
	/** What the far end calls this one: `lan port 2`, or `router:eth1` as `link` does. */
	label: string;
	port?: PortNo;
	nic?: NicName;
	/** What the port carries, when that is not VLAN 1. */
	vlan?: PortVlanView;
	/** `blocked` for a port that the spanning tree keeps out of use, or `learning` for one on its way into it. */
	tree?: string | null;
}
interface Edge {
	ends: readonly [End, End];
	hue?: PortHolder["hue"];
	/** Its link, or what its machine is doing. */
	link: string;
	/** Its conditions, when it has some. */
	conditions?: string;
}
/** A cable as one of its ends sees it. A cable from a switch to itself has a side at each of its ports. */
interface Side {
	edge: Edge;
	end: End;
	other: End;
}
const far = (edge: Edge, name: string) =>
	edge.ends[0].name === name ? edge.ends[1].name : edge.ends[1].name === name ? edge.ends[0].name : null;
const pair = (edge: Edge) => [edge.ends[0].name, edge.ends[1].name].sort().join(" ");
const sidesAt = (edges: readonly Edge[], name: string): Side[] =>
	edges
		.flatMap((edge) => {
			const [a, b] = edge.ends;
			return [
				{ edge, end: a, other: b },
				{ edge, end: b, other: a },
			];
		})
		.filter(({ end }) => end.name === name)
		.sort((x, y) => (x.end.port ?? 0) - (y.end.port ?? 0) || (x.end.nic ?? "").localeCompare(y.end.nic ?? ""));
/** The switch port at this side: its own, or for a NIC the one its cable is in. */
const portAt = ({ end, other }: Side) => (end.port === undefined ? other : end);
/** `eth1 · to lan port 2 · up · vlan 10`, `Port 8 · to lan port 7 · up · blocked`, or `Port 2 · router:eth1 · cut`, as the rack says a port. */
const sideWords = (side: Side) =>
	[
		side.end.port === undefined
			? `${side.end.nic} · to ${side.other.label}`
			: `Port ${side.end.port} · ${side.other.port === undefined ? "" : "to "}${side.other.label}`,
		side.edge.link,
		portAt(side).tree,
		portAt(side).vlan?.text,
		side.edge.conditions,
	]
		.filter(Boolean)
		.join(" · ");

/** A drawn line, and which it is of the lines between its two nodes. */
interface Wire {
	edge: Edge;
	index: number;
	of: number;
}
/** The map before the browser lays it out. Every drawn line is a held port or a cable between switches. */
interface Plan {
	/** One row group per connected component, each its breadth-first columns, so a line joins one column or two neighbours. */
	groups: readonly (readonly (readonly Device[])[])[];
	wires: readonly Wire[];
}

function plan(lab: LabState): Plan {
	const devices: Device[] = [
		...lab.switches.map((name) => ({ kind: "switch" as const, name })),
		...lab.rail.map((name) => ({ kind: "machine" as const, name })),
	];
	const at = (ref: PortRef): End => {
		const view = selectPorts(ref.switch)(lab).find((p) => p.port === ref.port);
		const tree = treeWord(view?.tree);
		return { name: ref.switch, label: `${ref.switch} port ${ref.port}`, port: ref.port, vlan: view?.vlan, tree };
	};
	const edges: Edge[] = [
		...lab.switches.flatMap((on) =>
			selectPorts(on)(lab).flatMap((p) =>
				p.machine
					? [
							{
								ends: [
									at({ switch: on, port: p.port }),
									{ name: p.machine.name, label: p.machine.label, nic: p.machine.nic ?? nicName(0) },
								] as const,
								hue: p.machine.hue,
								link: p.state,
								conditions: p.conditions,
							},
						]
					: [],
			),
		),
		...lab.switchCables.map(({ ends: [a, b], link }) => ({
			ends: [at(a), at(b)] as const,
			link,
			conditions: selectPorts(a.switch)(lab).find((p) => p.port === a.port)?.conditions,
		})),
	];
	const named = new Map(devices.map((device) => [device.name as string, device]));
	const seen = new Set<string>();
	const groups: Device[][][] = [];
	for (const root of devices) {
		if (seen.has(root.name)) continue;
		const columns: Device[][] = [];
		const queue: { name: string; depth: number }[] = [{ name: root.name, depth: 0 }];
		seen.add(root.name);
		for (const { name, depth } of queue) {
			const device = named.get(name);
			if (device) {
				columns[depth] ??= [];
				columns[depth].push(device);
			}
			for (const edge of edges) {
				const next = far(edge, name);
				if (next && !seen.has(next)) {
					seen.add(next);
					queue.push({ name: next, depth: depth + 1 });
				}
			}
		}
		groups.push(columns);
	}
	const wires = edges.map((edge) => {
		const beside = edges.filter((other) => pair(other) === pair(edge));
		return { edge, index: beside.indexOf(edge), of: beside.length };
	});
	return { groups, wires };
}

/** How far above its switch's tile the first cable from a switch to itself rises, and how much further each next one does. */
const LOOP = { lift: 14, step: 9, clear: 4 };

/** Where a node's tile is in the drawing, the column it stands in, and how much is clear to the right of that. */
interface Spot {
	x: number;
	y: number;
	half: number;
	left: number;
	right: number;
	room: number;
}

function spots(drawing: HTMLElement): Map<string, Spot> {
	const columns = [...drawing.querySelectorAll<HTMLElement>(".n-column")];
	const starts = [...new Set(columns.map((column) => column.offsetLeft))].sort((a, b) => a - b);
	const found = new Map<string, Spot>();
	for (const column of columns) {
		const left = column.offsetLeft;
		const right = left + column.offsetWidth;
		const room = (starts.find((start) => start >= right) ?? drawing.clientWidth) - right;
		for (const node of column.querySelectorAll<HTMLElement>(".n-node")) {
			const tile = node.querySelector<HTMLElement>(".n-tile");
			if (!tile) continue;
			found.set(node.dataset.machine ?? node.dataset.switch ?? "", {
				x: tile.offsetLeft + tile.offsetWidth / 2,
				y: tile.offsetTop + tile.offsetHeight / 2,
				half: tile.offsetHeight / 2,
				left,
				right,
				room,
			});
		}
	}
	return found;
}

/**
 * A line from one tile's centre to the other's. Names stand under tiles, so inside a column a line runs level with
 * its own tile, where no name is, and changes height only in the clear space between columns.
 */
function path(a: Spot, b: Spot, { index, of }: Wire): string {
	const fixed = (...numbers: number[]) => numbers.map((n) => Math.round(n * 10) / 10);
	if (a === b) {
		const [left, right, x1, x2, y, top] = fixed(
			a.x - 14,
			a.x + 14,
			a.x - 34,
			a.x + 34,
			a.y,
			a.y - (a.half + LOOP.lift + LOOP.step * index) / 0.75,
		);
		return `M ${left} ${y} C ${x1} ${top}, ${x2} ${top}, ${right} ${y}`;
	}
	// Lines between one pair run side by side, within their tiles' height.
	const shift = (index - (of - 1) / 2) * Math.min(8, (a.half * 1.2) / Math.max(1, of - 1));
	if (a.left === b.left) {
		// Two nodes of one column: round the outside of it, further out the further apart they are.
		const down = b.y < a.y ? -1 : 1;
		const out = Math.max(8, Math.min(a.room - 8, 12 + Math.abs(b.y - a.y) * 0.12 + 5 * index));
		const [ax, ay, bx, by, edge, turn] = fixed(
			a.x,
			a.y - down * shift,
			b.x,
			b.y + down * shift,
			a.right,
			a.right + out / 0.75,
		);
		return `M ${ax} ${ay} H ${edge} C ${turn} ${ay}, ${turn} ${by}, ${edge} ${by} H ${bx}`;
	}
	const [from, to] = a.x < b.x ? [a.right, b.left] : [a.left, b.right];
	const [ax, ay, bx, by, x1, x2, mid] = fixed(a.x, a.y + shift, b.x, b.y + shift, from, to, (from + to) / 2);
	return `M ${ax} ${ay} H ${x1} C ${mid} ${ay}, ${mid} ${by}, ${x2} ${by} H ${bx}`;
}

function mapOf({ groups, wires }: Plan, lab: LabState, selected: Selection | null, pick: (s: Selection) => void) {
	const edges = wires.map(({ edge }) => edge);
	const node = (d: Device) => {
		const m = d.kind === "machine" ? lab.machines[d.name] : null;
		// A wire has no words of its own, so each end of a cable with conditions says so.
		const impaired = edges.some((edge) => edge.conditions && edge.ends.some((end) => end.name === d.name));
		const marked = impaired ? ` · ${IMPAIRED}` : "";
		const meta =
			d.kind === "switch"
				? `${selectPorts(d.name)(lab).filter((port) => port.state !== "empty").length} / 8 ports${selectStorm(d.name)(lab) ? " · storming" : ""}${marked}`
				: `${m?.spec.image ?? ""}${marked}`;
		const words = sidesAt(edges, d.name).map(sideWords);
		const loops = edges.filter((edge) => edge.ends.every((end) => end.name === d.name)).length;
		return html`<button class="n-node" data-machine=${d.kind === "machine" ? d.name : nothing} data-switch=${d.kind === "switch" ? d.name : nothing} data-hue=${m?.hue ?? nothing} aria-pressed=${selected?.name === d.name} data-selected=${selected?.name === d.name} aria-description=${words.length ? words.join(". ") : nothing} title=${words.length ? words.join("\n") : nothing} style=${loops ? `padding-top:${LOOP.lift + LOOP.step * (loops - 1) + LOOP.clear}px` : nothing} @click=${() => pick(d)}>
			<span class="visually-hidden">Inspect ${d.kind} </span><span class="n-tile">${art(d.kind)}</span><span class="n-node-label"><strong>${d.name}</strong> <small>${meta}</small></span></button>`;
	};
	return html`<div class="n-map-scroll"><div class="n-drawing">
		<svg class="n-wires" aria-hidden="true">${wires.map(({ edge }) => {
			const related = edge.ends.some(
				(end) => selected?.name === end.name && (selected.kind !== "port" || selected.port === end.port),
			);
			// A cable that is whole and has an end that the spanning tree blocks carries nothing, and says so here.
			const state = (edge.link === "up" && edge.ends.find((end) => end.tree)?.tree) || edge.link;
			return svg`<path class="wire" data-state=${state} data-conditions=${edge.conditions ?? nothing} data-hue=${edge.hue ?? nothing} data-selected=${related}/>`;
		})}</svg>
		${groups.map((columns, row) =>
			columns.map(
				(devices, column) =>
					html`<div class="n-column" style=${`grid-area:${row + 1}/${2 * column + 1}`}>${devices.map(node)}</div>`,
			),
		)}</div></div>`;
}

/**
 * The lab as a map. The browser lays the nodes out, so a name of any length has the room it takes, and the lines are
 * then drawn to where the nodes are, again whenever one of them changes size.
 */
export class UnlabTopology extends UnlabElement {
	static override properties = {
		lab: { attribute: false },
		selected: { attribute: false },
		pick: { attribute: false },
	};
	declare lab: LabState;
	declare selected: Selection | null;
	declare pick: (selection: Selection) => void;

	#plan: Plan = { groups: [], wires: [] };
	readonly #resized = new ResizeObserver(() => this.#draw());

	override connectedCallback(): void {
		super.connectedCallback();
		this.#watch();
	}

	override disconnectedCallback(): void {
		this.#resized.disconnect();
		super.disconnectedCallback();
	}

	protected override willUpdate(): void {
		this.#plan = plan(this.lab);
	}

	override render() {
		return mapOf(this.#plan, this.lab, this.selected, this.pick);
	}

	protected override updated(): void {
		this.#watch();
		this.#draw();
	}

	/** A node that changes size moves the others of its column, and the drawing's width moves every column. */
	#watch(): void {
		this.#resized.disconnect();
		for (const box of this.querySelectorAll(".n-drawing, .n-node")) this.#resized.observe(box);
	}

	#draw(): void {
		const drawing = this.querySelector<HTMLElement>(".n-drawing");
		if (!drawing) return;
		const at = spots(drawing);
		for (const [i, line] of [...drawing.querySelectorAll(".wire")].entries()) {
			const wire = this.#plan.wires[i];
			const a = wire && at.get(wire.edge.ends[0].name);
			const b = wire && at.get(wire.edge.ends[1].name);
			const d = a && b && path(a, b, wire);
			if (d && line.getAttribute("d") !== d) line.setAttribute("d", d);
		}
	}
}

customElements.define("unlab-topology", UnlabTopology);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-topology": UnlabTopology;
	}
}
