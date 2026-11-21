// The left column: the machines in the lab, and everything about the one
// that is selected.

import type { Lab } from "../lab/lab.ts";
import type { Machine, Session } from "../lab/machine.ts";

const BADGE_COLORS = ["var(--badge-1)", "var(--badge-2)", "var(--badge-3)", "var(--badge-4)", "var(--badge-5)", "var(--badge-6)"];

/** A stable colour per machine, by its position in the lab. */
export function badgeColor(lab: Lab, m: Machine): string {
	const i = lab.machines.indexOf(m);
	return BADGE_COLORS[(i < 0 ? 0 : i) % BADGE_COLORS.length];
}

export function badgeEl(lab: Lab, m: Machine): HTMLElement {
	const b = document.createElement("span");
	b.className = "badge";
	b.style.background = badgeColor(lab, m);
	b.textContent = m.name.slice(0, 1);
	return b;
}

export interface SidebarHandlers {
	selectMachine: (id: string) => void;
	openSession: (s: Session) => void;
	newShell: (m: Machine) => void;
	removeMachine: (m: Machine) => void;
	pingOthers: (m: Machine) => void;
}

export function renderMachines(host: HTMLElement, lab: Lab, selectedId: string | undefined, h: SidebarHandlers): void {
	host.textContent = "";
	if (!lab.machines.length) {
		const e = document.createElement("div");
		e.className = "empty";
		e.style.padding = "4px 14px 10px";
		e.style.color = "var(--dimmer)";
		e.textContent = "No machines yet.";
		host.append(e);
		return;
	}

	for (const m of lab.machines) {
		const row = document.createElement("div");
		row.className = `machine ${m.state}${m.id === selectedId ? " selected" : ""}${m.link ? "" : " down"}`;
		row.append(badgeEl(lab, m));

		const nm = document.createElement("span");
		nm.className = "nm";
		nm.textContent = m.name;
		row.append(nm);

		const meta = document.createElement("span");
		meta.className = "meta";
		meta.textContent = `.${m.ip.split(".").pop()}`;
		row.append(meta);

		const dot = document.createElement("span");
		dot.className = `dot ${m.state}`;
		dot.title = m.status;
		row.append(dot);

		row.addEventListener("click", () => h.selectMachine(m.id));
		host.append(row);
	}
}

function kv(dl: HTMLElement, key: string, value: string, cls = ""): void {
	const dt = document.createElement("dt");
	dt.textContent = key;
	const dd = document.createElement("dd");
	dd.textContent = value;
	if (cls) dd.className = cls;
	dl.append(dt, dd);
}

export function renderDetail(
	host: HTMLElement,
	lab: Lab,
	m: Machine | undefined,
	openSessionIds: Set<string>,
	h: SidebarHandlers,
): void {
	host.textContent = "";
	if (!m) {
		const e = document.createElement("div");
		e.className = "empty";
		e.textContent = "Select a machine.";
		host.append(e);
		return;
	}

	const dl = document.createElement("dl");
	dl.className = "kv";
	kv(dl, "state", m.state === "ready" ? `up · ${m.bootMs} ms` : m.status, m.state === "ready" ? "ok" : m.state === "error" || m.state === "exited" ? "bad" : "");
	kv(dl, "address", `${m.ip}/${lab.subnet.bits}`);
	kv(dl, "mac", m.mac);
	kv(dl, "image", m.distro);
	kv(dl, "memory", `${m.memoryMiB} MiB`);
	kv(dl, "uplink", m.internet ? "internet (NAT)" : "lab only");
	kv(dl, "link", m.link ? "up" : "cut", m.link ? "ok" : "bad");
	const c = m.counters();
	if (c) kv(dl, "frames", `${c.rxFrames} in · ${c.txFrames} out · ${c.flooded} flooded`);
	host.append(dl);

	const acts = document.createElement("div");
	acts.className = "acts";
	const shell = document.createElement("button");
	shell.textContent = "New shell";
	shell.disabled = m.state !== "ready";
	shell.addEventListener("click", () => h.newShell(m));
	const link = document.createElement("button");
	link.textContent = m.link ? "Cut cable" : "Plug in";
	link.addEventListener("click", () => m.setLink(!m.link));
	const ping = document.createElement("button");
	ping.textContent = "Ping others";
	ping.disabled = m.state !== "ready" || lab.machines.length < 2;
	ping.addEventListener("click", () => h.pingOthers(m));
	const kill = document.createElement("button");
	kill.className = "danger";
	kill.textContent = "Remove";
	kill.addEventListener("click", () => h.removeMachine(m));
	acts.append(shell, link, ping, kill);
	host.append(acts);

	const list = document.createElement("div");
	list.className = "sesslist";
	for (const s of m.sessions) {
		const row = document.createElement("div");
		row.className = `sess${openSessionIds.has(s.id) ? " open-tab" : ""}`;
		const dot = document.createElement("span");
		dot.className = `dot ${s.state === "open" ? "ready" : s.state === "opening" ? "booting" : "closed"}`;
		const nm = document.createElement("span");
		nm.className = "nm";
		nm.textContent = s.label;
		const det = document.createElement("span");
		det.className = "det";
		det.textContent = s.detail;
		row.append(dot, nm, det);
		row.addEventListener("click", () => h.openSession(s));
		list.append(row);
	}
	host.append(list);
}
