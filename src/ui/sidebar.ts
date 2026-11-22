import type { Lab } from "../lab/lab.ts";
import type { Machine, Session } from "../lab/machine.ts";
import { icon } from "./icons.ts";

const colors = ["var(--mauve)", "var(--teal)", "var(--peach)", "var(--blue)", "var(--pink)", "var(--yellow)"];
export function machineColor(index: number): string {
	return colors[index % colors.length];
}

export interface SidebarHandlers {
	selectMachine: (id: string) => void;
	openSession: (s: Session) => void;
	newShell: (m: Machine) => void;
	removeMachine: (m: Machine) => void;
	pingOthers: (m: Machine) => void;
}

function span(className: string, value: string): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = className;
	el.textContent = value;
	return el;
}

export function renderMachines(host: HTMLElement, lab: Lab, selectedId: string | undefined, h: SidebarHandlers): void {
	host.replaceChildren();
	if (!lab.machines.length) host.append(span("empty", "No machines yet."));
	lab.machines.forEach((m, index) => {
		const row = document.createElement("button");
		row.className = "machine";
		row.style.setProperty("--machine-color", machineColor(index));
		row.setAttribute("aria-pressed", String(m.id === selectedId));
		const glyph = span("machine-icon", "");
		glyph.innerHTML = icon("machine");
		const label = span("machine-label", "");
		label.append(span("machine-name", m.name), span("machine-ip", m.ip));
		const dot = span(`dot ${m.state}`, "");
		dot.title = m.status;
		row.append(glyph, label, dot);
		row.addEventListener("click", () => h.selectMachine(m.id));
		host.append(row);
	});
}

function kv(dl: HTMLElement, key: string, value: string, cls = ""): HTMLElement {
	const dt = document.createElement("dt");
	dt.textContent = key;
	const dd = document.createElement("dd");
	dd.textContent = value;
	dd.className = cls;
	dl.append(dt, dd);
	return dd;
}

export function renderFrames(host: HTMLElement, machine: Machine): void {
	const c = machine.counters();
	host.textContent = c ? `${c.rxFrames} in · ${c.txFrames} out · ${c.flooded} flooded` : "—";
}

export function renderDetail(
	host: HTMLElement,
	lab: Lab,
	m: Machine | undefined,
	openSessionIds: Set<string>,
	h: SidebarHandlers,
): void {
	host.replaceChildren();
	if (!m) {
		host.append(span("empty", "Select a machine."));
		return;
	}
	const heading = document.createElement("h3");
	heading.className = "detail-name";
	heading.textContent = m.name;
	const dl = document.createElement("dl");
	dl.className = "kv";
	kv(dl, "State", m.state === "ready" ? `Ready · ${m.bootMs} ms` : m.status, m.state);
	kv(dl, "Image", m.distro);
	kv(dl, "Memory", `${m.memoryMiB} MiB`);
	kv(dl, "Address", `${m.ip}/${lab.subnet.bits}`);
	kv(dl, "MAC", m.mac);
	kv(dl, "Uplink", m.internet ? "Internet (NAT)" : "Lab only");
	kv(dl, "Link", m.link ? "Connected" : "Disconnected", m.link ? "ready" : "error");
	kv(dl, "Frames", "").id = "machine-frames";
	host.append(heading, dl);

	const acts = document.createElement("div");
	acts.className = "acts";
	const ping = document.createElement("button");
	ping.innerHTML = icon("send") + "Ping peers";
	ping.disabled = m.state !== "ready" || lab.machines.length < 2;
	ping.onclick = () => h.pingOthers(m);
	const link = document.createElement("button");
	link.innerHTML = icon("cable") + (m.link ? "Cut cable" : "Plug in");
	link.onclick = () => m.setLink(!m.link);
	acts.append(ping, link);
	host.append(acts);

	const sessions = document.createElement("h3");
	sessions.className = "section-label";
	sessions.textContent = "Sessions";
	host.append(sessions);
	for (const s of m.sessions) {
		const row = document.createElement("button");
		row.className = "sess";
		row.innerHTML = icon("terminal");
		row.append(span("nm", s.label), span("det", s.detail || (openSessionIds.has(s.id) ? "open" : s.state)));
		row.onclick = () => h.openSession(s);
		host.append(row);
	}
	const remove = document.createElement("button");
	remove.className = "danger";
	remove.innerHTML = icon("clear") + "Remove machine";
	remove.onclick = () => h.removeMachine(m);
	host.append(remove);
}
