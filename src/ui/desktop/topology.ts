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

/** Breadth-first columns, one row group per connected component. Every drawn line is a held port or a cable between switches. */
export function topologyMap(lab: LabState, selected: Selection | null, pick: (s: Selection) => void) {
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
	const layers = new Map<string, number>();
	const points = new Map<string, { x: number; y: number }>();
	let rows = 0,
		columns = 1;
	for (const root of devices) {
		if (layers.has(root.name)) continue;
		const groups: string[][] = [];
		const queue: string[] = [root.name];
		layers.set(root.name, 0);
		for (const name of queue) {
			const depth = layers.get(name) ?? 0;
			groups[depth] ??= [];
			groups[depth].push(name);
			for (const edge of edges) {
				const next = far(edge, name);
				if (next && !layers.has(next)) {
					layers.set(next, depth + 1);
					queue.push(next);
				}
			}
		}
		const height = Math.max(...groups.map((group) => group.length));
		for (const [col, group] of groups.entries()) {
			for (const [i, name] of group.entries())
				points.set(name, { x: col, y: rows + ((i + 0.5) * height) / group.length });
		}
		columns = Math.max(columns, groups.length);
		rows += height;
	}
	const width = Math.max(600, columns * 152),
		height = Math.max(280, rows * 116);
	function point(name: string) {
		const p = points.get(name);
		if (!p) throw Error(`No layout for ${name}`);
		return { x: ((p.x + 0.5) * width) / columns, y: (p.y / rows) * height - 12 };
	}
	return html`<div class="n-map-scroll"><div class="n-drawing" style=${`width:clamp(${columns * 84}px, 97%, ${width * 1.55}px);height:${height}px`}>
		<svg class="n-wires" preserveAspectRatio="none" viewBox=${`0 0 ${width} ${height}`} aria-hidden="true">${edges.map(
			(edge) => {
				const a = point(edge.ends[0].name),
					b = point(edge.ends[1].name);
				const related = edge.ends.some(
					(end) => selected?.name === end.name && (selected.kind !== "port" || selected.port === end.port),
				);
				const sibling = edges.filter((e) => pair(e) === pair(edge));
				const index = sibling.indexOf(edge);
				const offset = 8 * (index - (sibling.length - 1) / 2);
				const middle = (a.x + b.x) / 2;
				// A cable from a switch to itself loops over its node.
				const rise = 56 + 12 * index;
				const d =
					edge.ends[0].name === edge.ends[1].name
						? `M ${a.x - 14} ${a.y} C ${a.x - 34} ${a.y - rise}, ${a.x + 34} ${a.y - rise}, ${a.x + 14} ${a.y}`
						: `M ${a.x} ${a.y + offset} C ${middle} ${a.y + offset}, ${middle} ${b.y + offset}, ${b.x} ${b.y + offset}`;
				// A cable that is whole and has an end that the spanning tree blocks carries nothing, and says so here.
				const state = (edge.link === "up" && edge.ends.find((end) => end.tree)?.tree) || edge.link;
				return svg`<path class="wire" data-state=${state} data-conditions=${edge.conditions ?? nothing} data-hue=${edge.hue ?? nothing} data-selected=${related} d=${d}/>`;
			},
		)}</svg>
		${devices.map((d) => {
			const p = point(d.name),
				m = d.kind === "machine" ? lab.machines[d.name] : null;
			// A wire has no words of its own, so each end of a cable with conditions says so.
			const impaired = edges.some((edge) => edge.conditions && edge.ends.some((end) => end.name === d.name));
			const marked = impaired ? ` · ${IMPAIRED}` : "";
			const meta =
				d.kind === "switch"
					? `${selectPorts(d.name)(lab).filter((port) => port.state !== "empty").length} / 8 ports${selectStorm(d.name)(lab) ? " · storming" : ""}${marked}`
					: `${m?.spec.image ?? ""}${marked}`;
			// Rows are a fixed 116px apart, so the note says no more than it did, and each cable is in the title and description.
			const words = sidesAt(edges, d.name).map(sideWords);
			return html`<button class="n-node" data-machine=${d.kind === "machine" ? d.name : nothing} data-switch=${d.kind === "switch" ? d.name : nothing} data-hue=${m?.hue ?? nothing} aria-pressed=${selected?.name === d.name} data-selected=${selected?.name === d.name} aria-description=${words.length ? words.join(". ") : nothing} title=${words.length ? words.join("\n") : nothing} style=${`left:${(100 * p.x) / width}%;top:${p.y}px`} @click=${() => pick(d)}>
				<span class="visually-hidden">Inspect ${d.kind} </span>${art(d.kind)}<span class="n-node-label"><strong>${d.name}</strong> <small>${meta}</small></span></button>`;
		})}</div></div>`;
}
