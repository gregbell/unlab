// The right-hand panel: the lab's topology, every frame that crosses the
// switch, and what the switch has learned.

import { decode } from "../lab/decode.ts";
import type { Lab } from "../lab/lab.ts";
import type { TapEvent } from "../lab/switch.ts";

export type Packet = TapEvent & { decoded: ReturnType<typeof decode> };

export const MAX_PACKETS = 600;

export function toPacket(e: TapEvent): Packet {
	return { ...e, decoded: decode(e.frame) };
}

function esc(s: string): string {
	return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export function matches(p: Packet, q: string): boolean {
	const d = p.decoded;
	return `${d.proto} ${d.src} ${d.dst} ${d.info} ${p.fromName}`.toLowerCase().includes(q);
}

export function renderPackets(host: HTMLElement, packets: Packet[], filter: string): void {
	const rows = filter ? packets.filter((p) => matches(p, filter)) : packets;
	const shown = rows.slice(-200);
	const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;

	host.innerHTML = shown
		.map((p) => {
			const d = p.decoded;
			return `<div class="pkt${p.flooded ? " flood" : ""}"><span class="t">${(p.t / 1000).toFixed(2)}</span><span class="p ${d.proto}">${d.proto}</span><span class="d">${esc(d.src)} <span class="arrow">&rarr;</span> ${esc(d.dst)} <span class="info">${esc(d.info)}</span></span></div>`;
		})
		.join("");
	if (atBottom) host.scrollTop = host.scrollHeight;
}

export function renderStats(host: HTMLElement, lab: Lab, paused: boolean): void {
	let rx = 0;
	let tx = 0;
	let flooded = 0;
	for (const m of lab.machines) {
		const c = m.counters();
		if (!c) continue;
		rx += c.rxFrames;
		tx += c.txFrames;
		flooded += c.flooded;
	}
	host.textContent = `${lab.machines.length} machines · ${rx} in · ${tx} delivered · ${flooded} flooded${paused ? " · paused" : ""}`;
}

export function renderMacTable(host: HTMLElement, lab: Lab): void {
	const table = lab.sw.macTable();
	host.textContent = "";
	if (!table.length) {
		const d = document.createElement("div");
		d.textContent = "nothing learned yet";
		host.append(d);
		return;
	}
	for (const e of [...table].sort((a, b) => a.name.localeCompare(b.name))) {
		const d = document.createElement("div");
		const mac = document.createElement("span");
		mac.textContent = e.mac;
		const name = document.createElement("b");
		name.textContent = e.name;
		d.append(mac, name);
		host.append(d);
	}
}
