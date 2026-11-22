// The right-hand panel: the lab's topology, every frame that crosses the
// switch, and what the switch has learned.

import type { Lab } from "../lab/lab.ts";
import { decode } from "../net/index.ts";
import type { TapEvent } from "../runtime/switch.ts";

export type Packet = TapEvent & { t: number; decoded: ReturnType<typeof decode> };

export const MAX_PACKETS = 600;

export function toPacket(e: TapEvent): Packet {
	return { ...e, t: performance.now(), decoded: decode(e.frame) };
}

function esc(s: string): string {
	return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export function matches(p: Packet, q: string): boolean {
	const d = p.decoded;
	return `${d.proto} ${d.src} ${d.dst} ${d.info} port ${p.from}`.toLowerCase().includes(q);
}

export function renderPackets(host: HTMLElement, packets: Packet[], filter: string, paused: boolean): void {
	const rows = filter ? packets.filter((p) => matches(p, filter)) : packets;
	const shown = rows.slice(-200);
	if (!shown.length) {
		host.innerHTML = `<div class="capture-empty"><b>${filter ? "No matching packets" : paused ? "Capture paused" : "Listening for packets"}</b><span>${filter ? "Try a different filter." : paused ? "Resume capture to collect frames." : "Ping a peer to see traffic here."}</span></div>`;
		return;
	}
	const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 30;

	host.innerHTML = shown
		.map((p) => {
			const d = p.decoded;
			return `<div class="pkt${p.flood ? " flood" : ""}"><span class="t">${(p.t / 1000).toFixed(2)}</span><span class="p ${d.proto}">${d.proto}</span><span class="d">${esc(d.src)} <span class="arrow">&rarr;</span> ${esc(d.dst)} <span class="info">${esc(d.info)}</span></span></div>`;
		})
		.join("");
	if (atBottom) host.scrollTop = host.scrollHeight;
}

export function renderStats(host: HTMLElement, lab: Lab): void {
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
	host.textContent = `${rx} in · ${tx} delivered · ${flooded} flooded`;
}

export function renderMacTable(host: HTMLElement, lab: Lab): void {
	const table = lab.sw.macTable();
	host.textContent = "";
	if (!table.length) {
		const d = document.createElement("div");
		d.textContent = "No addresses learned yet";
		host.append(d);
		return;
	}
	const nameOf = (port: number) => lab.machines.find((m) => m.port === port)?.name ?? "?";
	for (const e of [...table].sort((a, b) => a.port - b.port)) {
		const d = document.createElement("div");
		const mac = document.createElement("span");
		mac.textContent = e.mac;
		const name = document.createElement("b");
		name.textContent = nameOf(e.port);
		d.append(mac, name);
		host.append(d);
	}
}
