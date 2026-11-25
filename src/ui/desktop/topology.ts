import { html, nothing, svg } from "lit";
import { type LabState, type MachineName, type PortNo, type SwitchName, selectPorts } from "../../model/index.ts";

export type Device = { kind: "switch"; name: SwitchName } | { kind: "machine"; name: MachineName };
export type Selection = Device | { kind: "port"; name: SwitchName; port: PortNo };
export const art = (kind: Device["kind"]) => html`<span aria-hidden="true" class="n-art ${kind}"><i></i><b></b></span>`;

/** Breadth-first columns, one row group per connected component. Every drawn line is a held port. */
export function topologyMap(lab: LabState, selected: Selection | null, pick: (s: Selection) => void) {
	const devices: Device[] = [
		...lab.switches.map((name) => ({ kind: "switch" as const, name })),
		...lab.rail.map((name) => ({ kind: "machine" as const, name })),
	];
	const edges = lab.switches.flatMap((on) =>
		selectPorts(on)(lab).flatMap((p) =>
			p.machine ? [{ on, machine: p.machine.name, hue: p.machine.hue, port: p.port, state: p.state }] : [],
		),
	);
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
				const next = edge.on === name ? edge.machine : edge.machine === name ? edge.on : null;
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
				const a = point(edge.on),
					b = point(edge.machine);
				const related =
					selected?.name === edge.machine ||
					(selected?.name === edge.on && (selected.kind !== "port" || selected.port === edge.port));
				const sibling = edges.filter((e) => e.on === edge.on && e.machine === edge.machine);
				const offset = 8 * (sibling.indexOf(edge) - (sibling.length - 1) / 2);
				const middle = (a.x + b.x) / 2;
				return svg`<path class="wire" data-state=${edge.state} data-hue=${edge.hue} data-selected=${related} d=${`M ${a.x} ${a.y + offset} C ${middle} ${a.y + offset}, ${middle} ${b.y + offset}, ${b.x} ${b.y + offset}`}/>`;
			},
		)}</svg>
		${devices.map((d) => {
			const p = point(d.name),
				m = d.kind === "machine" ? lab.machines[d.name] : null;
			const meta =
				d.kind === "switch" ? `${edges.filter((e) => e.on === d.name).length} / 8 ports` : (m?.spec.image ?? "");
			return html`<button class="n-node" data-machine=${d.kind === "machine" ? d.name : nothing} data-switch=${d.kind === "switch" ? d.name : nothing} data-hue=${m?.hue ?? nothing} aria-pressed=${selected?.name === d.name} data-selected=${selected?.name === d.name} style=${`left:${(100 * p.x) / width}%;top:${p.y}px`} @click=${() => pick(d)}>
				<span class="visually-hidden">Inspect ${d.kind} </span>${art(d.kind)}<span class="n-node-label"><strong>${d.name}</strong> <small>${meta}</small></span></button>`;
		})}</div></div>`;
}
