// The terminal's stylesheet first, so ours can override it.
import "@wterm/dom/css";
import "./style.css";

import { type DistroManifest, Lab } from "./lab/lab.ts";
import type { Machine, Session } from "./lab/machine.ts";
import { icon } from "./ui/icons.ts";
import { renderDetail, renderFrames, renderMachines, type SidebarHandlers } from "./ui/sidebar.ts";
import { TerminalPane } from "./ui/terminal.ts";
import { renderTopology } from "./ui/topology.ts";
import { MAX_PACKETS, type Packet, renderMacTable, renderPackets, renderStats, toPacket } from "./ui/wire.ts";
import { workspace } from "./ui/workspace.ts";

interface Tab {
	session: Session;
	pane: TerminalPane;
}

const app = document.getElementById("app") as HTMLDivElement;
const tabs: Tab[] = [];
const packets: Packet[] = [];

let lab: Lab;
let activeSessionId: string | undefined;
let selectedMachineId: string | undefined;
let paused = false;
let filter = "";
let wireOpen = true;
let framePending = false;
let workspaceDirty = false;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function toast(message: string): void {
	const el = document.createElement("div");
	el.className = "toast";
	el.textContent = message;
	document.body.append(el);
	setTimeout(() => el.remove(), 6000);
}

/** Collapse repeated redraws into one per frame. */
function invalidate(): void {
	workspaceDirty = true;
	scheduleRender();
}

function scheduleRender(): void {
	if (framePending || !lab) return;
	framePending = true;
	requestAnimationFrame(() => {
		framePending = false;
		if (workspaceDirty) render();
		workspaceDirty = false;
		renderTraffic();
	});
}

// ------------------------------------------------------------------ layout

function shell(): void {
	app.innerHTML = workspace;
	const dialog = byId<HTMLDialogElement>("add-dialog");
	byId("add").addEventListener("click", () => dialog.showModal());
	byId("cancel-add").addEventListener("click", () => dialog.close());
	byId("machine-form").addEventListener("submit", (event) => {
		event.preventDefault();
		addMachine();
	});
	const machinesToggle = byId("toggle-machines");
	machinesToggle.addEventListener("click", () => {
		machinesToggle.setAttribute("aria-expanded", String(byId("side").classList.toggle("expanded")));
	});
	byId("new-shell").addEventListener("click", () => {
		const m = selectedMachine();
		if (m) handlers.newShell(m);
	});
	byId("toggle-wire").addEventListener("click", () => {
		wireOpen = !wireOpen;
		byId("wire").classList.toggle("hidden", !wireOpen);
		byId("toggle-wire").setAttribute("aria-pressed", String(wireOpen));
		fitActive();
		invalidate();
	});
	byId("toggle-wire").setAttribute("aria-pressed", String(wireOpen));
	byId("pause").addEventListener("click", () => {
		paused = !paused;
		const button = byId("pause");
		button.innerHTML = icon(paused ? "play" : "pause");
		button.title = paused ? "Resume capture" : "Pause capture";
		button.setAttribute("aria-label", button.title);
		byId("capture-state").textContent = paused ? "Paused" : "Live";
		byId("capture-state").classList.toggle("paused", paused);
		invalidate();
	});
	byId("clear-pkts").addEventListener("click", () => {
		packets.length = 0;
		invalidate();
	});
	byId<HTMLInputElement>("pkt-filter").addEventListener("input", (e) => {
		filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
		invalidate();
	});
}

// ----------------------------------------------------------------- machines

function selectedMachine(): Machine | undefined {
	return selectedMachineId ? lab.byId(selectedMachineId) : undefined;
}

function addMachine(): void {
	const nameEl = byId<HTMLInputElement>("new-name");
	try {
		const m = lab.add({
			name: nameEl.value,
			distro: byId<HTMLSelectElement>("new-distro").value,
			internet: byId<HTMLInputElement>("new-net").checked,
		});
		byId<HTMLDialogElement>("add-dialog").close();
		nameEl.value = "";
		selectedMachineId = m.id;
		void openTab(m.console);
	} catch (e) {
		toast(e instanceof Error ? e.message : String(e));
	}
}

const handlers: SidebarHandlers = {
	selectMachine: (id) => {
		selectedMachineId = id;
		// Show something from that machine: a tab it already has, or its console.
		const existing = tabs.find((t) => t.session.machine.id === id);
		void openTab(existing ? existing.session : lab.byId(id)?.console);
	},
	openSession: (s) => void openTab(s),
	newShell: (m) => {
		if (m.state !== "ready") {
			toast(`${m.name} is not up yet`);
			return;
		}
		void openTab(m.openShell());
	},
	removeMachine: (m) => {
		for (const t of tabs.filter((t) => t.session.machine.id === m.id)) closeTab(t, false);
		lab.remove(m.id);
		if (selectedMachineId === m.id) {
			selectedMachineId = lab.machines[0]?.id;
			activeSessionId = undefined;
			void openTab(tabs[0]?.session ?? selectedMachine()?.console);
		}
		invalidate();
	},
	pingOthers: (m) => {
		const others = lab.machines.filter((x) => x.id !== m.id);
		if (!others.length) return;
		const s = tabs.find((t) => t.session.machine.id === m.id)?.session ?? m.console;
		void openTab(s).then(() =>
			s.write(`for h in ${others.map((o) => o.name).join(" ")}; do ping -c 2 -W 2 $h; done\n`),
		);
	},
};

// --------------------------------------------------------------------- tabs

async function openTab(session: Session | undefined): Promise<void> {
	if (!session) return;
	byId("side").classList.remove("expanded");
	byId("toggle-machines").setAttribute("aria-expanded", "false");
	selectedMachineId = session.machine.id;
	const found = tabs.find((t) => t.session.id === session.id);
	if (found) {
		activate(session.id);
		return;
	}
	const pane = new TerminalPane(session);
	const tab: Tab = { session, pane };
	tabs.push(tab);
	activeSessionId = session.id;
	// Hide the pane that was showing before the new one mounts, or both paint.
	applyActive();
	invalidate();
	await pane.mount(byId("panes"), activeSessionId === session.id);
	// Another tab may have been opened while the WASM core loaded.
	applyActive();
	invalidate();
}

/** Exactly one pane paints: the active one. */
function applyActive(): void {
	for (const t of tabs) t.pane.setActive(t.session.id === activeSessionId);
}

function activate(sessionId: string): void {
	activeSessionId = sessionId;
	applyActive();
	const t = tabs.find((x) => x.session.id === sessionId);
	if (t) selectedMachineId = t.session.machine.id;
	invalidate();
}

function closeTab(tab: Tab, pick = true): void {
	const i = tabs.indexOf(tab);
	if (i < 0) return;
	tabs.splice(i, 1);
	tab.pane.destroy();
	// A shell belongs to its tab; the console belongs to the machine.
	if (tab.session.kind === "shell") tab.session.close();
	if (pick && activeSessionId === tab.session.id) {
		const next = tabs[Math.min(i, tabs.length - 1)];
		if (next) activate(next.session.id);
		else activeSessionId = undefined;
	}
	invalidate();
}

function renderTabs(): void {
	const strip = byId("tabstrip");
	strip.textContent = "";
	for (const t of tabs) {
		const m = t.session.machine;
		const el = document.createElement("div");
		el.className = `tab${t.session.id === activeSessionId ? " active" : ""}`;

		const select = document.createElement("button");
		select.className = "tab-select";
		select.setAttribute("aria-pressed", String(t.session.id === activeSessionId));
		select.innerHTML = icon("terminal");
		select.append(m.name, document.createTextNode(" / " + t.session.label));
		select.addEventListener("click", () => activate(t.session.id));

		const close = document.createElement("button");
		close.className = "close";
		close.textContent = "×";
		close.title = t.session.kind === "shell" ? "Close this shell" : "Close this tab";
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			closeTab(t);
		});

		close.setAttribute("aria-label", `Close ${t.session.title}`);
		el.append(select, close);
		strip.append(el);
	}
	byId("nothing").style.display = tabs.length ? "none" : "grid";
}

function fitActive(): void {
	const t = tabs.find((x) => x.session.id === activeSessionId);
	if (!t) return;
	requestAnimationFrame(() => t.pane.fit());
}

// ------------------------------------------------------------------- render

function render(): void {
	const ready = lab.machines.filter((m) => m.state === "ready").length;
	byId("lab-status").textContent =
		`${ready} of ${lab.machines.length} ${lab.machines.length === 1 ? "machine" : "machines"} ready`;
	byId("lab-dot").className = `dot ${ready > 0 && ready === lab.machines.length ? "ready" : "booting"}`;
	byId("machine-count").textContent = String(lab.machines.length);
	byId("session-count").textContent = `${tabs.length} open ${tabs.length === 1 ? "session" : "sessions"}`;
	renderTabs();
	renderMachines(byId("machines"), lab, selectedMachineId, handlers);
	renderDetail(byId("detail"), lab, selectedMachine(), new Set(tabs.map((t) => t.session.id)), handlers);
	byId<HTMLButtonElement>("new-shell").disabled = selectedMachine()?.state !== "ready";
	renderTopology(byId("topo"), lab, selectedMachineId, (id) => handlers.selectMachine(id));
}

function renderTraffic(): void {
	const frames = document.getElementById("machine-frames");
	const machine = selectedMachine();
	if (frames && machine) renderFrames(frames, machine);
	if (!wireOpen) return;
	renderPackets(byId("packets"), packets, filter, paused);
	renderStats(byId("stats"), lab);
	renderMacTable(byId("mac"), lab);
}

// -------------------------------------------------------------------- start

async function main(): Promise<void> {
	shell();

	const res = await fetch("distros/distros.json");
	if (!res.ok) {
		toast("No mirrored images. Run: node scripts/fetch-distros.ts alpine");
		return;
	}
	const manifest = (await res.json()) as DistroManifest;

	lab = new Lab({ manifest, onChange: invalidate });

	document.title = `unlab — ${lab.subnet}`;
	const sel = byId<HTMLSelectElement>("new-distro");
	for (const distro of manifest.distros) {
		sel.add(new Option(distro.image.split("-").slice(0, 2).join(" "), distro.name));
	}

	byId("subnet").textContent = String(lab.subnet);
	byId<HTMLButtonElement>("add").disabled = false;

	lab.sw.onTap((e) => {
		if (!paused) {
			packets.push(toPacket(e));
			if (packets.length > MAX_PACKETS) packets.splice(0, packets.length - MAX_PACKETS);
		}
		scheduleRender();
	});

	new ResizeObserver(() => fitActive()).observe(byId("panes"));
	new ResizeObserver(invalidate).observe(byId("topo"));

	// Two machines, so the point of the place is visible at once.
	const first = lab.add({ name: "node1" });
	lab.add({ name: "node2" });
	selectedMachineId = first.id;
	await openTab(first.console);
}

void main();
