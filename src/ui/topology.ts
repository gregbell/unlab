// The lab drawn as it is wired: every machine on one switch. Clicking a cable
// pulls it, which is the quickest way to watch a protocol notice.

import type { Lab } from "../lab/lab.ts";

const W = 436;
const SWITCH_Y = 104;
const TOP_Y = 26;

function esc(s: string): string {
	return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export function renderTopology(host: HTMLElement, lab: Lab, activeId: string | undefined, onSelect: (id: string) => void): void {
	const ms = lab.machines;
	if (!ms.length) {
		host.innerHTML = "";
		return;
	}

	const step = W / (ms.length + 1);
	const parts: string[] = [];

	parts.push(
		`<rect x="12" y="${SWITCH_Y}" width="${W - 24}" height="22" rx="5" class="sw" />`,
		`<text x="${W / 2}" y="${SWITCH_Y + 15}" class="sw-label" text-anchor="middle">switch &middot; ${esc(String(lab.subnet))}</text>`,
	);

	ms.forEach((m, i) => {
		const x = step * (i + 1);
		const c = lab.sw.counters(m.id);
		const busy = (c?.rxFrames ?? 0) + (c?.txFrames ?? 0);
		const cls = [m.link ? "up" : "down", m.state, m.id === activeId ? "active" : ""].join(" ");
		parts.push(
			`<g class="node ${cls}" data-id="${m.id}">`,
			`<line x1="${x}" y1="${TOP_Y + 26}" x2="${x}" y2="${SWITCH_Y}" class="cable" />`,
			`<rect x="${x - 34}" y="${TOP_Y}" width="68" height="26" rx="5" class="box" />`,
			`<text x="${x}" y="${TOP_Y + 12}" text-anchor="middle" class="nm">${esc(m.name)}</text>`,
			`<text x="${x}" y="${TOP_Y + 22}" text-anchor="middle" class="ad">.${esc(m.ip.split(".").pop() ?? "")}</text>`,
			`<text x="${x}" y="${SWITCH_Y - 5}" text-anchor="middle" class="ct">${m.link ? busy : "cut"}</text>`,
			`</g>`,
		);
	});

	host.innerHTML = `<svg viewBox="0 0 ${W} ${SWITCH_Y + 30}" class="topo">${parts.join("")}</svg>`;

	for (const g of host.querySelectorAll<SVGGElement>("g.node")) {
		const id = g.dataset.id;
		if (!id) continue;
		g.addEventListener("click", (e) => {
			const m = lab.byId(id);
			if (!m) return;
			// The cable toggles the link; the box selects the machine.
			if ((e.target as Element).classList.contains("cable")) m.setLink(!m.link);
			else onSelect(id);
		});
	}
}
