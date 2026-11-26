import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { isLineError } from "../../commands/index.ts";
import {
	ACCEPTS,
	addressText,
	DEFAULT_SWITCH,
	disksOf,
	type Machine,
	nicPortsOf,
	type PortCable,
	type PortView,
	parseSessionId,
	type SessionId,
	type SwitchName,
	selectCliSegment,
	selectFocused,
	selectPorts,
	selectRail,
	selectStorm,
	selectSubnets,
} from "../../model/index.ts";
import { addressStr } from "../../net/index.ts";
import { maximiseIcon, parkIcon, restoreIcon } from "../base/icons.ts";
import { closeIcon, UnlabElement } from "../base/index.ts";
import { CLI_COMMAND, cliGuidance } from "../cli-link/cli-link.ts";
import { AUTHOR_URL, LIVE_LAB_URL, REPO_URL, X_ACCOUNT, X_URL } from "../links.ts";
import { peerPing } from "../machine-details/peer-ping.ts";
import {
	alignWithLab,
	type Box,
	firstDesktop,
	type Item,
	item,
	loadLayout,
	type Point,
	resized,
	startupBoxes,
} from "./layout.ts";
import { type Device, type Selection, topologyMap } from "./topology.ts";
import "./topology.css";
import "./desktop.css";
import "./machine-wizard.ts";

import type { SpawnChoice } from "../spawn-form/form.ts";
import { type Icon, icon, launcherMark } from "./icons.ts";

const storage = "unlab.desktop.layout.v1";
const utilityTitles = {
	welcome: "Welcome to unLAB",
	inspector: "Packet inspector",
	spawn: "Add machines",
	agent: "WebMCP",
	switch: "Add switch",
	patch: "Patch cable",
	about: "About unLAB",
	ssh: "SSH access",
} as const;
type UtilityKind = keyof typeof utilityTitles;
const utilitySize: Record<UtilityKind, [number, number]> = {
	welcome: [788, 432],
	inspector: [850, 480],
	spawn: [648, 470],
	agent: [420, 510],
	switch: [420, 245],
	patch: [420, 245],
	about: [465, 350],
	ssh: [465, 440],
};
type Utility = Box & { kind: UtilityKind; id: string; z: number; state: Item["state"]; resumeMax?: boolean };
type Win = Item | Utility;
type ContextTarget = Device | { kind: "window"; id: string } | { kind: "desktop" };
type Menu = "main" | "console" | "capture" | null;
const visible = (w: Win) => w.state === "open" || w.state === "max";
const terminalLabel = (session: string, compact = false) => {
	const ref = parseSessionId(session);
	if (!ref) return "Terminal";
	if (compact) return ref.shell ? `${ref.machine} · ${ref.label}` : ref.machine;
	return `${ref.machine} · terminal${ref.shell ? ` ${ref.shell}` : ""}`;
};
const label = (w: Win) =>
	w.kind === "switch-details"
		? `${w.name} · Switch details`
		: w.kind === "config"
			? `${w.name} · Configuration`
			: w.kind === "topology"
				? "Topology"
				: w.kind === "rack"
					? "Rack manager"
					: w.kind === "console"
						? terminalLabel(w.session)
						: w.kind === "capture"
							? `Capture · ${w.on}`
							: w.kind === "note"
								? "Note"
								: utilityTitles[w.kind];
const mark = (w: Win): Icon =>
	w.kind === "welcome"
		? "rack"
		: w.kind === "inspector"
			? "capture"
			: w.kind === "switch-details"
				? "switch"
				: w.kind === "topology"
					? "network"
					: w.kind === "config" || w.kind === "spawn"
						? "machine"
						: w.kind;
const rect = (b: Box) => `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
const edges = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const cap = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
const farEnd = ({ to }: PortCable) => `${to.switch} port ${to.port}`;
const taken = (ports: readonly PortView[]) => ports.filter((p) => p.state !== "empty").length;
class Desktop extends UnlabElement {
	private layout = loadLayout(storage, firstDesktop);
	private utilities: Utility[] = [];
	private initialChoice?: SpawnChoice;
	private active = "";
	private flights = new Map<string, { animation?: Animation }>();
	private observer = new ResizeObserver(() => this.requestUpdate());
	private typing: string | null = null;
	private menu: Menu = null;
	private menuTimer = 0;
	private rackMenu = false;
	private contextTerminals = false;
	private context: { target: ContextTarget; anchor: HTMLElement; position: Point } | null = null;
	private patchOrigin = "";
	private picked: Selection | null = null;
	private source = "";
	private destination = "";
	private notice = "";
	private network = Array<number>(18).fill(0);
	private previousFrames = 0;
	private sampleAt = 0;
	private clean = new AbortController();
	private unsub?: () => void;
	private clock = 0;
	private toast = 0;
	private drag: { w: Win; before: Box; start: Point; dir: string } | null = null;
	private snap: "left" | "right" | "full" | null = null;
	get lab() {
		return this.app.store.state;
	}
	private get windows() {
		return [...this.layout.items, ...this.utilities];
	}
	private get front() {
		return this.windows.filter(visible).sort((a, b) => b.z - a.z)[0];
	}
	private get area() {
		const el = this.querySelector(".dt-work");
		return { w: el?.clientWidth ?? innerWidth, h: el?.clientHeight ?? innerHeight - 110 };
	}
	override connectedCallback() {
		super.connectedCallback();
		if (this.clean.signal.aborted) this.clean = new AbortController();
		alignWithLab(this.layout, this.lab);
		if (!this.layout.items.some((w) => w.kind === "topology")) {
			this.layout.items.push(item({ kind: "topology" }, startupBoxes().topology, 1));
		}
		this.active = this.front?.id ?? "";
		const name = selectFocused(this.lab) ?? this.lab.rail[0];
		if (name) {
			this.picked = { kind: "machine", name };
			if (!localStorage.getItem(storage)) {
				const session = this.lab.machines[name]?.activeSession;
				if (session) this.showSession(session, false, startupBoxes().terminal(0));
			}
		}
		let previous = this.lab;
		this.unsub = this.app.store.subscribe(() => {
			const before = previous;
			const next = this.lab;
			previous = next;
			if (next.rail !== before.rail || next.switches !== before.switches) {
				alignWithLab(this.layout, next);
				if (this.picked?.kind === "switch" && !next.switches.includes(this.picked.name)) this.picked = null;
				if (this.context?.target.kind === "switch" && !next.switches.includes(this.context.target.name))
					this.closeContext();
				if (!this.windows.some((w) => w.id === this.active && visible(w))) {
					this.active = this.front?.id ?? "";
					this.typing = null;
				}
				this.save();
			}
			if (before.rail.length === 0 && next.rail.length > 0) this.dismissUtility("welcome");
			if (before.rail.length > 0 && next.rail.length === 0) this.utility("welcome");
			if (next.rail !== before.rail) {
				const added = next.rail.filter((name) => !before.machines[name]);
				const fromWizard = before.view === "spawn";
				const firstBoot = !before.rail.length;
				const boxes = startupBoxes();
				const columns = boxes.narrow ? 1 : 2;
				for (const [index, name] of added.entries()) {
					const machine = next.machines[name];
					if (!machine) continue;
					let box: Box | undefined;
					if ((firstBoot || fromWizard) && index < columns) box = boxes.terminal(index);
					else if (fromWizard) {
						const base = boxes.terminal(index % columns);
						const offset = Math.min(Math.floor(index / columns) * 32, base.h - 128);
						box = { ...base, y: base.y + offset, h: base.h - offset };
					}
					const win = this.showSession(machine.activeSession, fromWizard && index === added.length - 1, box);
					if (firstBoot && !fromWizard && index >= columns) {
						win.state = "mini";
						this.active = this.front?.id ?? "";
						this.changed();
					}
				}
			}
			const command = next.log.at(-1);
			if (
				before.log !== next.log &&
				command &&
				command.source !== "button" &&
				command.outcome === "ok" &&
				/^(focus|sh) /.test(command.line)
			) {
				const n = selectFocused(next),
					session = n && next.machines[n]?.activeSession;
				if (session) {
					const w = this.showSession(session);
					if (command.line.split(" ").includes("--max")) this.maximise(w);
				}
			}
			if (before.log !== next.log && command?.outcome === "ok" && /^capture(?: |$)/.test(command.line))
				this.utility("inspector");
			if (next.view !== before.view) {
				if (next.view === "spawn") {
					this.dismissUtility("welcome");
					this.utility("spawn");
				} else {
					this.dismissUtility("spawn");
					if (next.rail.length === 0) this.utility("welcome");
				}
			}
			if (next.agentPanel !== before.agentPanel) {
				if (next.agentPanel) this.utility("agent");
				else this.dismissUtility("agent");
			}
			if (
				before.machines !== next.machines ||
				before.rail !== next.rail ||
				before.switches !== next.switches ||
				before.switchCables !== next.switchCables ||
				before.storms !== next.storms ||
				before.sessions !== next.sessions ||
				before.keyboard !== next.keyboard ||
				before.view !== next.view ||
				before.agentPanel !== next.agentPanel ||
				before.cli !== next.cli
			)
				this.requestUpdate();
		});
		if (this.lab.view === "spawn") this.launch("spawn");
		else if (this.lab.rail.length === 0) this.utility("welcome");
		if (this.lab.agentPanel) this.utility("agent");
		const opts = { signal: this.clean.signal };
		window.addEventListener("pointerdown", this.outside, { ...opts, capture: true });
		window.addEventListener("pointermove", this.move, opts);
		window.addEventListener("pointerup", this.up, opts);
		window.addEventListener(
			"pointercancel",
			() => {
				this.drag = null;
				this.snap = null;
				this.requestUpdate();
			},
			opts,
		);
		window.addEventListener("resize", () => this.requestUpdate(), opts);
		window.addEventListener("keydown", this.keys, opts);
		window.addEventListener("pagehide", () => this.save(), opts);
		this.previousFrames = this.app.capture.counters.in;
		this.sampleAt = performance.now();
		this.clock = window.setInterval(() => {
			const count = this.app.capture.counters.in,
				now = performance.now();
			this.network = [
				...this.network.slice(1),
				Math.max(0, Math.round(((count - this.previousFrames) * 1000) / (now - this.sampleAt))),
			];
			this.sampleAt = now;
			this.previousFrames = count;
			this.requestUpdate();
		}, 1000);
		this.restoreShells();
	}
	private restoreShells() {
		// A reload restarts the guests. Recreate one shell for each saved secondary terminal window.
		for (const machine of this.lab.rail) void this.restoreMachineShells(machine);
	}
	private async restoreMachineShells(machine: Machine["name"]) {
		const windows = this.layout.items.filter(
			(w) =>
				w.kind === "console" &&
				w.state !== "closed" &&
				parseSessionId(w.session)?.machine === machine &&
				parseSessionId(w.session)?.shell,
		);
		if (!windows.length) return;
		const number = this.lab.machines[machine]?.n;
		const signal = AbortSignal.any([this.clean.signal, AbortSignal.timeout(90000)]);
		try {
			await this.app.store.until(
				(s) => s.machines[machine]?.n !== number || s.machines[machine]?.life.phase === "ready",
				signal,
			);
			for (const w of windows) {
				const m = this.lab.machines[machine];
				if (!m || m.n !== number || m.life.phase !== "ready" || signal.aborted) return;
				if (w.kind !== "console" || !this.layout.items.includes(w) || w.state === "closed") continue;
				const session = `${machine}:sh${m.nextShell}`;
				if (!(await this.run(`sh ${machine}`))) return;
				w.session = session;
				this.changed();
			}
		} catch (error) {
			if (!signal.aborted) this.tell(error instanceof Error ? error.message : String(error));
		}
	}
	protected override firstUpdated() {
		const work = this.querySelector(".dt-work");
		if (work) this.observer.observe(work);
	}
	override disconnectedCallback() {
		this.observer.disconnect();
		this.clean.abort();
		for (const flight of this.flights.values()) flight.animation?.cancel();
		this.flights.clear();
		this.unsub?.();
		clearInterval(this.clock);
		clearTimeout(this.menuTimer);
		clearTimeout(this.toast);
		super.disconnectedCallback();
	}
	private save() {
		localStorage.setItem(storage, JSON.stringify(this.layout));
	}
	private changed() {
		this.save();
		this.requestUpdate();
	}
	private tell(text: string) {
		this.notice = text;
		clearTimeout(this.toast);
		this.toast = window.setTimeout(() => {
			this.notice = "";
			this.requestUpdate();
		}, 4500);
		this.requestUpdate();
	}
	private async run(line: string) {
		const r = await this.app.commands.run(line, "button");
		if (isLineError(r) || r.kind === "failed") {
			this.tell(isLineError(r) ? r.message : r.error.message);
			return false;
		}
		return true;
	}
	private fit(b: Box): Box {
		const a = this.area,
			w = cap(b.w, Math.min(260, a.w), a.w),
			h = cap(b.h, Math.min(128, a.h), a.h);
		return { w, h, x: cap(b.x, 0, a.w - w), y: cap(b.y, 0, a.h - h) };
	}
	private box(w: Win) {
		return w.state === "max" || (w.resumeMax && this.flights.has(w.id)) ? { x: 0, y: 0, ...this.area } : this.fit(w);
	}
	private raise(w: Win, terminal = false) {
		const from = w.state === "mini" ? this.dockButton(w)?.getBoundingClientRect() : undefined;
		if (!visible(w)) w.state = w.resumeMax ? "max" : "open";
		w.resumeMax = false;
		if (this.front?.id !== w.id) w.z = 1 + Math.max(0, ...this.windows.map((i) => i.z));
		this.active = w.id;
		this.typing = terminal && w.kind === "console" ? w.id : null;
		const ref = terminal && w.kind === "console" ? parseSessionId(w.session) : null;
		if (
			ref &&
			this.lab.machines[ref.machine]?.life.phase === "ready" &&
			(selectFocused(this.lab) !== ref.machine || this.lab.machines[ref.machine]?.activeSession !== ref.session)
		)
			void this.run(`focus ${ref.session}`);
		this.changed();
		if (from) void this.animateDock(w, from, true);
	}
	private dockButton(w: Win) {
		return this.querySelector<HTMLButtonElement>(`[data-restore="${CSS.escape(w.id)}"]`);
	}
	private cancelFlight(w: Win) {
		this.flights.get(w.id)?.animation?.cancel();
		this.flights.delete(w.id);
	}
	private async animateDock(w: Win, origin: DOMRect, restoring: boolean) {
		this.cancelFlight(w);
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const ticket: { animation?: Animation } = {};
		this.flights.set(w.id, ticket);
		this.requestUpdate();
		try {
			await this.updateComplete;
			if (this.flights.get(w.id) !== ticket) return;
			const el = this.windowEl(w);
			if (!el) return;
			const base = el.getBoundingClientRect(),
				button = this.dockButton(w);
			if (button && !restoring) button.scrollIntoView({ block: "nearest", inline: "nearest" });
			const end = restoring ? base : button?.getBoundingClientRect();
			if (!end || !base.width || !base.height) return;
			const frame = (r: DOMRect, opacity: number) => ({
				transformOrigin: "top left",
				transform: `translate(${r.left - base.left}px,${r.top - base.top}px) scale(${r.width / base.width},${r.height / base.height})`,
				opacity,
			});
			ticket.animation = el.animate([frame(origin, restoring ? 0.2 : 1), frame(end, restoring ? 1 : 0.2)], {
				duration: restoring ? 205 : 245,
				easing: restoring ? "cubic-bezier(.16,1,.32,1)" : "cubic-bezier(.42,0,.75,.5)",
				fill: "both",
			});
			await ticket.animation.finished;
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
		} finally {
			if (this.flights.get(w.id) === ticket) {
				ticket.animation?.cancel();
				this.flights.delete(w.id);
				this.requestUpdate();
			}
		}
	}
	private minimise(w: Win) {
		const from = this.windowEl(w)?.getBoundingClientRect();
		w.resumeMax = w.state === "max";
		w.state = "mini";
		this.active = this.front?.id ?? "";
		this.typing = null;
		this.changed();
		if (from) void this.animateDock(w, from, false);
	}
	private maximise(w: Win) {
		const was = w.state;
		this.raise(w);
		w.state = was === "max" ? "open" : "max";
		this.changed();
	}
	private close(w: Win) {
		this.cancelFlight(w);
		if (w.kind === "welcome") this.dismissUtility("welcome");
		else if (w.kind === "spawn") this.app.store.dispatchUi({ type: "ui/view", view: "lab" });
		else if (w.kind === "agent") this.app.store.dispatchUi({ type: "ui/agent-panel", open: false });
		else if (
			w.kind === "inspector" ||
			w.kind === "switch" ||
			w.kind === "patch" ||
			w.kind === "about" ||
			w.kind === "ssh"
		)
			this.dismissUtility(w.kind);
		else if (w.kind === "console" || w.kind === "rack" || w.kind === "topology") {
			w.state = "closed";
			w.resumeMax = false;
		} else this.layout.items = this.layout.items.filter((i) => i.id !== w.id);
		this.active = this.front?.id ?? "";
		this.typing = null;
		this.changed();
	}
	private nextBox(width: number, height: number) {
		const a = this.area,
			offset = 18 * (this.windows.filter(visible).length % 5);
		return this.fit({ x: (a.w - width) / 2 + offset, y: (a.h - height) / 2 + offset, w: width, h: height });
	}
	private utility(kind: UtilityKind) {
		let w = this.utilities.find((w) => w.kind === kind);
		if (!w) {
			w = {
				...this.nextBox(...utilitySize[kind]),
				kind,
				id: kind,
				z: 0,
				state: "open",
			};
			if (kind === "welcome") {
				const area = this.area;
				w.x = (area.w - w.w) / 2;
				w.y = (area.h - w.h) / 2;
			}
			this.utilities.push(w);
		}
		this.raise(w);
	}
	private dismissUtility(kind: UtilityKind) {
		if (kind === "spawn") this.initialChoice = undefined;
		this.utilities = this.utilities.filter((w) => w.kind !== kind);
		if (this.active === kind) this.active = this.front?.id ?? "";
		this.requestUpdate();
	}
	private showRack(kind: "rack" | "topology" = "rack") {
		const w = this.layout.items.find((i) => i.kind === kind);
		if (w) this.raise(w);
	}
	private async console(name: string, extra = false) {
		const n = this.lab.rail.find((n) => n === name),
			m = n && this.lab.machines[n];
		if (!m) return;
		const same = this.layout.items.filter((w) => w.kind === "console" && w.session.startsWith(`${name}:`));
		const old = same.find((w) => w.state !== "closed") ?? same[0];
		if (old && !extra) {
			this.raise(old, true);
			return;
		}
		let session: SessionId | undefined = m.sessions.find(
			(id) => !same.some((w) => w.kind === "console" && w.session === id),
		);
		if (!session) {
			const id = `${m.name}:sh${m.nextShell}`;
			if (!(await this.run(`sh ${name}`))) return;
			session = this.lab.machines[m.name]?.sessions.find((s) => s === id);
		}
		if (session) this.showSession(session);
	}
	private showSession(session: SessionId, keyboard = true, box?: Box) {
		let w = this.layout.items.find((w) => w.kind === "console" && w.session === session);
		if (!w) {
			w = item({ kind: "console", session }, box ?? this.nextBox(600, 328), 0);
			this.layout.items.push(w);
		}
		this.raise(w, keyboard);
		return w;
	}
	private capture(on: string) {
		let w = this.layout.items.find((w) => w.kind === "capture" && w.on === on);
		if (!w) {
			w = item({ kind: "capture", on }, this.nextBox(558, 246), 0);
			this.layout.items.push(w);
		}
		this.raise(w);
	}
	private note() {
		const w = item({ kind: "note", text: "" }, this.nextBox(370, 230), 0);
		this.layout.items.push(w);
		this.raise(w);
		void this.updateComplete.then(() => this.windowEl(w)?.querySelector("textarea")?.focus());
	}
	private windowEl(w: Win) {
		return this.querySelector<HTMLElement>(`[data-window="${CSS.escape(w.id)}"]`);
	}
	private openMenu(m: Menu, keyboard = true) {
		clearTimeout(this.menuTimer);
		this.menu = m;
		this.typing = null;
		this.requestUpdate();
		void this.updateComplete.then(() => {
			if (m && keyboard)
				this.querySelector<HTMLElement>(
					m === "main" ? ".dt-root-menu > .dt-entry > button" : ".dt-flyout button",
				)?.focus();
		});
	}
	private openContext(e: MouseEvent | KeyboardEvent) {
		const el = e.target;
		if (!(el instanceof HTMLElement || el instanceof SVGElement)) return;
		const work = this.querySelector(".dt-work");
		if (!work?.contains(el)) return;
		const device = el.closest<HTMLElement>("[data-machine],[data-switch]"),
			title = el.closest<HTMLElement>(".dt-title");
		const w = this.windows.find((w) => w.id === el.closest<HTMLElement>(".dt-window")?.dataset.window);
		let target: ContextTarget, anchor: HTMLElement;
		if (device) {
			const m = this.lab.rail.find((n) => n === device.dataset.machine),
				sw = this.lab.switches.find((n) => n === device.dataset.switch);
			if (m) target = { kind: "machine", name: m };
			else if (sw) target = { kind: "switch", name: sw };
			else return;
			anchor = device.querySelector<HTMLButtonElement>(".dt-device") ?? device;
		} else if (w && title) {
			target = { kind: "window", id: w.id };
			anchor = title;
		} else if (el === work && el instanceof HTMLElement) {
			target = { kind: "desktop" };
			anchor = el;
		} else return;
		e.preventDefault();
		clearTimeout(this.menuTimer);
		this.menu = null;
		this.rackMenu = false;
		if (w) this.raise(w);
		const r = anchor.getBoundingClientRect();
		const position =
			e instanceof MouseEvent && (e.clientX || e.clientY)
				? { x: e.clientX, y: e.clientY }
				: { x: r.left + 8, y: r.top + Math.min(r.height, 30) };
		this.showContext(target, anchor, position);
	}
	private showContext(target: ContextTarget, anchor: HTMLElement, position: Point, fromButton = false) {
		const context = { target, anchor, position };
		this.contextTerminals = false;
		this.context = context;
		this.requestUpdate();
		void this.updateComplete.then(() => {
			if (this.context !== context) return;
			const menu = this.querySelector<HTMLElement>(".dt-context");
			if (!menu) return;
			const x = fromButton ? position.x - menu.offsetWidth : position.x;
			const y =
				fromButton && position.y + menu.offsetHeight > innerHeight - 5
					? anchor.getBoundingClientRect().top - menu.offsetHeight - 4
					: position.y;
			menu.style.left = `${cap(x, 5, innerWidth - menu.offsetWidth - 5)}px`;
			menu.style.top = `${cap(y, 5, innerHeight - menu.offsetHeight - 5)}px`;
			menu.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
		});
	}
	private closeContext(back = false) {
		if (back) this.context?.anchor.focus({ preventScroll: true });
		this.context = null;
		this.requestUpdate();
	}
	private async openContextTerminals(focus: boolean) {
		if (!this.lab.rail.length) return;
		this.contextTerminals = true;
		this.requestUpdate();
		await this.updateComplete;
		const parent = this.querySelector<HTMLElement>(".dt-context [data-submenu]");
		const flyout = this.querySelector<HTMLElement>(".dt-context .dt-flyout");
		if (!parent || !flyout) return;
		const r = parent.getBoundingClientRect();
		const x = r.right + flyout.offsetWidth + 5 <= innerWidth ? r.right : r.left - flyout.offsetWidth;
		flyout.style.left = `${cap(x, 5, innerWidth - flyout.offsetWidth - 5)}px`;
		flyout.style.top = `${cap(r.top - 5, 5, innerHeight - flyout.offsetHeight - 5)}px`;
		if (focus) flyout.querySelector("button")?.focus();
	}
	private contextKeys(e: KeyboardEvent) {
		const trigger = this.querySelector<HTMLButtonElement>(".dt-context [data-submenu]");
		if (e.key === "ArrowRight" && trigger && document.activeElement === trigger) {
			e.preventDefault();
			void this.openContextTerminals(true);
			return;
		}
		if (this.contextTerminals && (e.key === "ArrowLeft" || e.key === "Escape")) {
			e.preventDefault();
			this.contextTerminals = false;
			this.requestUpdate();
			trigger?.focus();
			return;
		}
		if (e.key === "Escape" || e.key === "Tab") {
			this.closeContext(true);
			if (e.key === "Escape") e.preventDefault();
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
		e.preventDefault();
		const inFlyout = document.activeElement?.closest(".dt-context .dt-flyout");
		const buttons = Array.from(
			this.querySelectorAll<HTMLButtonElement>(
				inFlyout ? ".dt-context .dt-flyout > button:enabled" : ".dt-context > button:enabled",
			),
		);
		if (!inFlyout && this.contextTerminals) {
			this.contextTerminals = false;
			this.requestUpdate();
		}
		const at = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
		buttons[
			e.key === "Home"
				? 0
				: e.key === "End"
					? buttons.length - 1
					: (at + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length
		]?.focus();
	}
	private contextView() {
		if (!this.context) return nothing;
		const { target, position } = this.context;
		const action = (name: string, glyph: ReturnType<typeof icon>, fn: () => void, disabled = false) =>
			html`<button role="menuitem" @pointerenter=${() => {
				if (this.contextTerminals) {
					this.contextTerminals = false;
					this.requestUpdate();
				}
			}} ?disabled=${disabled} @click=${() => {
				this.closeContext(true);
				fn();
			}}>${glyph}${name}</button>`;
		let entries: ReturnType<typeof action>[];
		let title: string;
		let glyph: Icon;
		switch (target.kind) {
			case "window": {
				const w = this.windows.find((w) => w.id === target.id);
				if (!w) return nothing;
				title = label(w);
				glyph = mark(w);
				entries = [
					action(w.state === "max" ? "Restore size" : "Maximize", w.state === "max" ? restoreIcon : maximiseIcon, () =>
						this.maximise(w),
					),
					action("Minimize", parkIcon, () => this.minimise(w)),
					action("Close window", closeIcon, () => this.close(w)),
				];
				break;
			}
			case "machine": {
				const machine = this.lab.machines[target.name];
				if (!machine) return nothing;
				const ping = this.pingAction(machine);
				const accepts = ACCEPTS[machine.life.phase];
				title = target.name;
				glyph = target.kind;
				entries = [
					...(this.context.anchor.hasAttribute("data-device-actions")
						? []
						: [action("Configuration", icon("machine"), () => this.inspect(target))]),
					action("Open terminal", icon("console"), () => void this.console(target.name)),
					action("New terminal", icon("plus"), () => void this.console(target.name, true)),
					action(ping.label, icon("network"), ping.run, ping.disabled),
					html`<hr>`,
					...(accepts.boot
						? [action("Boot", icon("power"), () => void this.run(`boot ${machine.name}`))]
						: [
								action("Reboot", icon("reboot"), () => void this.run(`reboot ${machine.name}`), !accepts.commands),
								action("Power off", icon("power"), () => void this.run(`poweroff ${machine.name}`), !accepts.commands),
							]),
					html`<hr>`,
					action(
						"Delete VM…",
						icon("trash"),
						() => this.app.commands.confirmInBar(`rm ${machine.name}`),
						!accepts.remove,
					),
				];
				break;
			}
			case "switch": {
				if (!this.lab.switches.includes(target.name)) return nothing;
				title = target.name;
				glyph = target.kind;
				const free = selectPorts(target.name)(this.lab).find((p) => p.state === "empty");
				entries = [
					...(this.context.anchor.hasAttribute("data-device-actions")
						? []
						: [action("Switch details", icon("switch"), () => this.inspect(target))]),
					action("Open capture", icon("capture"), () => this.capture(target.name)),
					action(
						"Patch cable…",
						icon("patch"),
						() => {
							if (free) this.patchInterface("", `${target.name}:${free.port}`);
						},
						!free,
					),
					html`<hr>`,
					action(
						"Delete switch…",
						icon("trash"),
						() => this.app.commands.confirmInBar(`rmswitch ${target.name}`),
						target.name === DEFAULT_SWITCH,
					),
				];
				break;
			}
			case "desktop":
				title = "Desktop";
				glyph = "rack";
				entries = [
					action("Rack manager", icon("rack"), () => this.showRack()),
					action("Topology", icon("network"), () => this.showRack("topology")),
					action("Add machines…", icon("machine"), () => this.launch("spawn")),
					html`<button role="menuitem" data-submenu="console" aria-haspopup="menu" aria-expanded=${this.contextTerminals} ?disabled=${!this.lab.rail.length}
						@pointerenter=${(e: PointerEvent) => {
							if (e.pointerType === "mouse") void this.openContextTerminals(false);
						}}
						@click=${() => this.openContextTerminals(true)}>${icon("console")}New terminal<span aria-hidden="true">›</span></button>`,
					...(this.contextTerminals ? [this.terminalFlyout(() => this.closeContext(true))] : []),
				];
				break;
		}
		return html`<div class="dt-menu dt-context" role="menu" aria-label=${`${title} actions`} style=${`left:${position.x}px;top:${position.y}px`}><div class="dt-menu-caption" data-hue=${target.kind === "machine" ? (this.lab.machines[target.name]?.hue ?? nothing) : nothing}>${icon(glyph)}${title}</div>${entries}</div>`;
	}
	private outside = (e: PointerEvent) => {
		if (this.context && e.target instanceof Element && !e.target.closest(".dt-context, [data-device-actions]"))
			this.closeContext();
		if (this.rackMenu && e.target instanceof Element && !e.target.closest(".dt-rack-actions")) {
			this.rackMenu = false;
			this.requestUpdate();
		}
		if (this.menu && e.target instanceof Element && !e.target.closest(".dt-launcher")) {
			this.menu = null;
			this.requestUpdate();
		}
	};
	private keys = (e: KeyboardEvent) => {
		if (this.context) {
			this.contextKeys(e);
			return;
		}
		if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
			this.openContext(e);
			return;
		}
		if (this.rackMenu && e.key === "Escape") {
			this.rackMenu = false;
			this.requestUpdate();
		}
		if (!this.menu) return;
		const el = document.activeElement,
			child = el?.closest(".dt-flyout"),
			parent = el?.closest<HTMLButtonElement>("[data-submenu]");
		const buttons = Array.from(
			this.querySelectorAll<HTMLButtonElement>(child ? ".dt-flyout > button" : ".dt-root-menu > .dt-entry > button"),
		);
		if ((e.key === "Escape" && this.menu !== "main") || (e.key === "ArrowLeft" && child)) {
			e.preventDefault();
			const was = this.menu;
			this.openMenu("main", false);
			this.querySelector<HTMLButtonElement>(`[data-submenu="${was}"]`)?.focus();
		} else if (e.key === "Escape") {
			this.openMenu(null);
			this.querySelector<HTMLButtonElement>(".dt-logo")?.focus();
		} else if (e.key === "ArrowRight" && parent) {
			e.preventDefault();
			this.openMenu(parent.dataset.submenu === "console" ? "console" : "capture");
		} else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
			e.preventDefault();
			const at = buttons.indexOf(el as HTMLButtonElement);
			const next =
				e.key === "Home"
					? 0
					: e.key === "End"
						? buttons.length - 1
						: (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
			if (!child) this.openMenu("main", false);
			buttons[next]?.focus();
		} else if (e.key === "Tab") this.openMenu(null, false);
	};
	private hoverMenu(menu: Exclude<Menu, null>, e: PointerEvent) {
		if (e.pointerType !== "mouse") return;
		clearTimeout(this.menuTimer);
		if (this.menu !== menu) this.menuTimer = window.setTimeout(() => this.openMenu(menu, false), 135);
	}
	private launch(action: UtilityKind | "rack" | "topology" | "console" | "capture" | "note") {
		if (action === "console" || action === "capture") {
			this.openMenu(action);
			return;
		}
		this.openMenu(null);
		if (action === "rack" || action === "topology") this.showRack(action);
		else if (action === "note") this.note();
		else if (action === "spawn") {
			this.app.store.dispatchUi({ type: "ui/view", view: "spawn" });
			this.utility("spawn");
		} else if (action === "agent") {
			this.app.store.dispatchUi({ type: "ui/agent-panel", open: true });
			this.utility("agent");
		} else {
			if (action === "patch") this.patchOrigin = this.active;
			this.utility(action);
		}
	}
	private terminalFlyout(close: () => void) {
		return html`<div class="dt-menu dt-flyout" role="menu" aria-label="New terminal">${this.lab.rail.map(
			(name) =>
				html`<button role="menuitem" data-hue=${this.lab.machines[name]?.hue ?? nothing} @click=${() => {
					close();
					void this.console(name, true);
				}}>${icon("console")}${name}</button>`,
		)}</div>`;
	}
	private menuView() {
		const actions = [
			["rack", "Rack manager", "rack"],
			["topology", "Topology", "network"],
			["spawn", "Add machines…", "machine"],
			["switch", "Add switch…", "switch"],
			["patch", "Patch cable…", "patch"],
			["console", "New terminal", "console"],
			["capture", "Packet capture", "capture"],
			["note", "New note", "note"],
			["agent", utilityTitles.agent, "agent"],
			["ssh", utilityTitles.ssh, "ssh"],
			["about", utilityTitles.about, "about"],
		] as const;
		if (!this.menu) return nothing;
		return html`<div class="dt-menu dt-root-menu" role="menu" aria-label="Lab menu">${actions.map(
			([action, title, glyph]) => {
				const sub = action === "console" || action === "capture",
					expanded = sub && this.menu === action;
				return html`<div class="dt-entry" @pointerenter=${(e: PointerEvent) => this.hoverMenu(sub ? action : "main", e)} @pointerleave=${() => clearTimeout(this.menuTimer)}>
				<button role="menuitem" aria-haspopup=${sub ? "menu" : nothing} aria-expanded=${sub ? expanded : nothing} data-submenu=${sub ? action : nothing} @click=${() => this.launch(action)}>${icon(glyph)}${title}${sub ? html`<span aria-hidden="true">›</span>` : nothing}</button>
				${
					expanded
						? action === "console"
							? this.terminalFlyout(() => this.openMenu(null))
							: html`<div class="dt-menu dt-flyout" role="menu" aria-label=${title}><button role="menuitem" @click=${() => this.launch("inspector")}>${icon("capture")}Packet inspector</button>${this.lab.switches.map(
									(name) =>
										html`<button role="menuitem" @click=${() => {
											this.openMenu(null);
											this.capture(name);
										}}>${icon(glyph)}${name}</button>`,
								)}</div>`
						: nothing
				}
			</div>`;
			},
		)}</div>`;
	}
	private handleDown(e: PointerEvent, w: Win) {
		const el = e.target;
		if (e.button !== 0 || !(el instanceof Element)) return;
		const term = !!el.closest("unlab-terminal");
		this.raise(w, term);
		if (term) return;
		if (el.closest("button,input,select,textarea")) return;
		const dir = el.closest("[data-edge]")?.getAttribute("data-edge") ?? "";
		if (!dir && !el.closest(".dt-title")) return;
		e.preventDefault();
		this.windowEl(w)?.focus({ preventScroll: true });
		this.drag = { w, before: this.box(w), start: { x: e.clientX, y: e.clientY }, dir };
	}
	private move = (e: PointerEvent) => {
		const d = this.drag;
		if (!d) return;
		let dx = e.clientX - d.start.x,
			dy = e.clientY - d.start.y;
		if (d.w.state === "max") {
			if (Math.abs(dx) + Math.abs(dy) < 5) return;
			d.w.state = "open";
			d.before = this.fit({ ...d.w, x: e.clientX - (d.start.x / this.area.w) * d.w.w, y: 0 });
			d.start = { x: e.clientX, y: e.clientY };
			dx = dy = 0;
		}
		if (d.dir) Object.assign(d.w, this.fit(resized(d.before, d.dir, dx, dy)));
		else {
			Object.assign(d.w, this.fit({ ...d.before, x: d.before.x + dx, y: d.before.y + dy }));
			this.snap = e.clientY <= 46 ? "full" : e.clientX < 10 ? "left" : e.clientX > innerWidth - 10 ? "right" : null;
		}
		this.requestUpdate();
	};
	private up = () => {
		if (!this.drag) return;
		if (this.drag && this.snap) {
			const w = this.drag.w,
				a = this.area;
			if (this.snap === "full") w.state = "max";
			else Object.assign(w, { x: this.snap === "left" ? 0 : a.w / 2, y: 0, w: a.w / 2, h: a.h });
		}
		this.snap = null;
		this.drag = null;
		this.changed();
	};
	private status() {
		const ms = this.lab.rail.flatMap((n) => this.lab.machines[n] ?? []),
			ready = ms.filter((m) => m.life.phase === "ready").length,
			cpus = ms.reduce((sum, m) => sum + (m.spec.cpus ?? 1), 0);
		const peak = Math.max(1, ...this.network),
			points = this.network.map((n, i) => `${i * 2.4},${17 - (14 * n) / peak}`).join(" ");
		return html`<div class="dt-status" aria-label="Lab status"><span title=${`${ready} of ${ms.length} machines ready`}><i class="dt-led" data-ready=${ready === ms.length && ready > 0}></i>${ms.length} machines</span><span title="Virtual CPUs configured across all machines">${icon("cpu")}${cpus} vCPU</span><span title="Frames received by lab switches per second">${icon("network")}${this.network.at(-1)} pkt/s<svg class="dt-spark" viewBox="0 0 42 20" aria-hidden="true"><polyline points=${points}></polyline></svg></span></div>`;
	}
	private inspect(device: Device) {
		if (device.kind === "machine") {
			const machine = this.lab.machines[device.name];
			if (!machine) return;
			this.picked = device;
			let window = this.layout.items.find((w) => w.kind === "config" && w.machineNumber === machine.n);
			if (!window) {
				window = item({ kind: "config", name: machine.name, machineNumber: machine.n }, this.nextBox(490, 455), 0);
				this.layout.items.push(window);
			}
			this.raise(window);
			return;
		}
		if (!this.lab.switches.includes(device.name)) return;
		this.picked = device;
		let window = this.layout.items.find((w) => w.kind === "switch-details" && w.name === device.name);
		if (!window) {
			window = item({ kind: "switch-details", name: device.name }, this.nextBox(490, 465), 0);
			this.layout.items.push(window);
		}
		this.raise(window);
	}
	private patchInterface(source = "", destination = "") {
		this.source = source;
		this.destination = destination;
		this.launch("patch");
	}
	private deviceRow(device: Device) {
		const { name, kind } = device,
			lab = this.lab;
		const machine = device.kind === "machine" ? lab.machines[device.name] : undefined;
		const ports = device.kind === "switch" ? selectPorts(device.name)(lab) : [];
		const storm = device.kind === "switch" && selectStorm(device.name)(lab);

		const detail = machine
			? `${machine.spec.image} · ${machine.spec.cpus ?? 1} vCPU · ${machine.spec.memMiB} MiB`
			: `${taken(ports)} / ${ports.length} ports · ${device.kind === "switch" ? selectSubnets(device.name)(lab) : ""}`;
		const summary =
			machine && machine.life.phase !== "ready"
				? `${detail} · ${machine.life.phase}`
				: storm
					? `${detail} · storming`
					: detail;
		const portLabels = ports.map((p) => {
			const held = p.machine?.label ?? (p.cable && `to ${farEnd(p.cable)}`);
			return `Port ${p.port} · ${held ? `${held} · ${p.state}` : "Empty"}`;
		});
		const portStrip = ports.length
			? html`<span class="dt-port-strip" aria-hidden="true">${ports.map(
					(p, i) => html`<span class="dt-port-block" data-state=${p.state} title=${portLabels[i]}></span>`,
				)}</span>`
			: nothing;
		return html`<div class="dt-row" data-machine=${machine ? name : nothing} data-switch=${kind === "switch" ? name : nothing} data-hue=${machine?.hue ?? nothing}>
		<div class="dt-row-main"><button class="dt-device" aria-description=${ports.length ? portLabels.join(". ") : nothing} @click=${() => this.inspect(device)}><span class="visually-hidden">${kind === "machine" ? "Configure" : "Inspect"} </span>${icon(kind)}<span><span class="dt-device-name"><b>${name}</b>${portStrip}</span> <small>${summary}</small></span></button>
		${machine ? this.terminalButton(machine.name) : html`<button class="dt-primary" @click=${() => this.capture(name)}>Open capture ↗</button>`}</div>
		</div>`;
	}
	private rackBody() {
		const lab = this.lab,
			used = lab.switches.flatMap((on) => selectPorts(on)(lab)).filter((p) => p.state === "up").length;
		return html`<div class="dt-rackbar"><b>Equipment</b><button class="dt-map-open" @click=${() => this.showRack("topology")}>${icon("network")} Topology ↗</button><div class="dt-rack-actions"><button class="dt-add" aria-expanded=${this.rackMenu} @click=${() => {
			this.rackMenu = !this.rackMenu;
			this.requestUpdate();
		}}>${icon("plus")} Add ${icon("chevron")}</button>
		${
			this.rackMenu
				? html`<div class="dt-menu">${(
						[
							["spawn", "Add machines…", "machine"],
							["switch", "Add switch…", "switch"],
							["patch", "Patch cable…", "patch"],
						] as const
					).map(
						([action, title, glyph]) =>
							html`<button @click=${() => {
								this.rackMenu = false;
								this.launch(action);
							}}>${icon(glyph)}${title}</button>`,
					)}</div>`
				: nothing
		}</div></div>
		<div class="dt-rack-scroll"><div class="dt-group"><h3>Machines <span>${lab.rail.length}</span></h3>${lab.rail.map((name) => this.deviceRow({ kind: "machine", name }))}</div>
		<div class="dt-group"><h3>Switches <span>${lab.switches.length}</span></h3>${lab.switches.map((name) => this.deviceRow({ kind: "switch", name }))}</div></div>
		<footer class="dt-rackfoot"><span><i class="dt-led" data-ready=${used > 0}></i>${used} ${used === 1 ? "link" : "links"} up</span><span>${lab.switches.length} ${lab.switches.length === 1 ? "switch" : "switches"}</span></footer>`;
	}
	private terminalButton(name: string) {
		return html`<button type="button" class="dt-primary dt-terminal-icon" aria-label=${`Open terminal for ${name}`} title=${`Open terminal for ${name}`} @click=${() => this.console(name)}>${icon("console")}</button>`;
	}
	private pingAction(m: Machine) {
		const { label, line } = peerPing(m.name, this.lab.machines, selectRail(this.lab));
		return {
			label,
			disabled: !line || !ACCEPTS[m.life.phase].commands,
			run: () => {
				if (!line) return;
				this.showSession(m.activeSession);
				void this.run(line);
			},
		};
	}
	private deviceActions(e: Event, target: Device) {
		const button = e.currentTarget;
		if (!(button instanceof HTMLButtonElement)) return;
		if (this.context?.anchor === button) {
			this.closeContext(true);
			return;
		}
		const bounds = button.getBoundingClientRect();
		this.showContext(target, button, { x: bounds.right, y: bounds.bottom + 4 }, true);
	}
	private deviceActionsButton(device: Device) {
		return html`<button type="button" class="dt-primary dt-terminal-icon" data-device-actions=${device.name} aria-label=${`More actions for ${device.name}`} title="More actions" aria-haspopup="menu" aria-expanded=${this.context?.anchor.dataset.deviceActions === device.name} @click=${(e: Event) => this.deviceActions(e, device)}>${icon("more")}</button>`;
	}
	private configuration(m: Machine) {
		const ping = this.pingAction(m);
		const ports = nicPortsOf(m.life),
			accepts = ACCEPTS[m.life.phase];
		return html`<div class="dt-config" data-hue=${m.hue}><div class="dt-config-tools"><strong>${m.name} · ${m.life.phase}</strong>${this.terminalButton(m.name)}${this.deviceActionsButton({ kind: "machine", name: m.name })}</div>
		${m.life.phase === "failed" ? html`<p class="dt-boot-error">${m.life.reason}</p>` : nothing}
		<h3>Compute</h3><dl><div><dt>Guest image</dt><dd>${m.spec.image}</dd></div><div><dt>Virtual CPUs</dt><dd>${m.spec.cpus ?? 1}</dd></div><div><dt>Memory</dt><dd>${m.spec.memMiB} MiB</dd></div></dl>
		<h3>Storage</h3><dl>${disksOf(m.spec).map((d, i) => html`<div><dt>${i === 0 ? "Root" : "Data"} · ${d.device}</dt><dd>${d.gib} GiB</dd></div>`)}</dl>
		<div class="dt-config-network"><h3>Network</h3><button class="dt-primary" ?disabled=${ping.disabled} @click=${ping.run}>${ping.label}</button></div><dl><div><dt>Package gateway</dt><dd>${m.spec.gateway ? "Enabled" : "Disabled"}</dd></div></dl>
		${m.spec.nics.map((nic, i) => {
			const port = ports[i],
				held = port && selectPorts(port.switch)(this.lab).find((p) => p.port === port.port);
			return html`<div class="dt-link"><span>eth${i}<small>${nic.address ? addressStr(nic.address) : "No address"}</small></span><span>${port ? `${port.switch}:${port.port}` : "Unplugged"}<small>${[held?.state, held?.vlan?.text].filter(Boolean).join(" · ")}</small></span><button ?disabled=${!accepts.cables} @click=${() => this.patchInterface(`${m.name}:eth${i}`)}>Patch</button></div>`;
		})}</div>`;
	}
	private switchDetails(name: SwitchName) {
		const ports = selectPorts(name)(this.lab),
			storm = selectStorm(name)(this.lab),
			vlans = ports.some((p) => p.vlan);
		return html`<div class="dt-config"><div class="dt-config-tools"><strong>${taken(ports)} / ${ports.length} ports connected${storm ? " · storming" : ""}</strong>
			<button class="dt-primary dt-terminal-icon" aria-label=${`Open capture for ${name}`} title="Open capture" @click=${() => this.capture(name)}>${icon("capture")}</button>
			${this.deviceActionsButton({ kind: "switch", name })}</div>
			<h3>Network</h3><dl><div><dt>Subnets</dt><dd>${selectSubnets(name)(this.lab)}</dd></div>
			<div><dt>Links up</dt><dd>${ports.filter((p) => p.state === "up").length}</dd></div>
			${storm ? html`<div><dt>Storm</dt><dd>${storm.rate} looped frames a second · ${storm.dropped} dropped</dd></div>` : nothing}</dl>
			<h3>Ports</h3><table class="dt-ports" aria-label=${`Ports on ${name}`}><thead><tr><th>Port</th><th>Machine</th><th>Link</th>${vlans ? html`<th>VLAN</th>` : nothing}<th aria-label="Cable action"></th></tr></thead>
			<tbody>${ports.map((p) => {
				const m = p.machine,
					cable = p.cable,
					line = m?.label ?? cable?.label;
				return html`<tr><th scope="row">${p.port}</th>
				<td>${m ? html`<button data-hue=${m.hue} class="dt-peer" title=${`Configure ${m.name}`} @click=${() => this.inspect({ kind: "machine", name: m.name })}>${m.label}</button>` : cable ? html`<button class="dt-peer" title=${`Inspect ${cable.to.switch}`} @click=${() => this.inspect({ kind: "switch", name: cable.to.switch })}>${farEnd(cable)}</button>` : "Available"}</td>
				<td data-state=${p.state}>${line ? p.state : "—"}</td>
				${vlans ? html`<td>${p.vlan?.text ?? (line ? "vlan 1" : "—")}</td>` : nothing}
				<td>${line ? html`<button class="dt-primary" ?disabled=${!p.actionLabel} title=${p.actionLabel ?? nothing} @click=${() => this.run(`link ${p.state === "cut" ? "up" : "down"} ${line}`)}>${p.state === "cut" ? "Reconnect" : "Cut cable"}</button>${cable ? html` <button class="dt-primary" title=${`Remove the cable to ${farEnd(cable)}`} @click=${() => this.run(`uncable ${cable.label}`)}>Remove</button>` : nothing}` : html`<button class="dt-primary" @click=${() => this.patchInterface("", `${name}:${p.port}`)}>Patch</button>`}</td></tr>`;
			})}</tbody></table></div>`;
	}
	private topologyBody() {
		return html`<div class="dt-map n-network">${topologyMap(this.lab, this.picked, (device) => {
			if (device.kind !== "port") this.inspect(device);
		})}</div>`;
	}
	private patchForm() {
		const nics = this.lab.rail.flatMap((n) => this.lab.machines[n]?.spec.nics.map((_, i) => `${n}:eth${i}`) ?? []);
		const dest = this.lab.switches.flatMap((s) =>
			selectPorts(s)(this.lab)
				.filter((p) => p.state === "empty")
				.map((p) => `${s}:${p.port}`),
		);
		const source = nics.includes(this.source) ? this.source : nics[0],
			to = this.destination === "none" || dest.includes(this.destination) ? this.destination : (dest[0] ?? "none");
		return html`<form class="dt-form" @submit=${async (e: Event) => {
			e.preventDefault();
			if (source && (await this.run(to === "none" ? `unplug ${source}` : `plug ${source} ${to}`))) {
				this.dismissUtility("patch");
				const origin = this.windows.find((w) => w.id === this.patchOrigin && visible(w));
				if (origin) this.raise(origin);
				else this.showRack();
			}
		}}><label>Machine interface<select class="field" @change=${(e: Event) => {
			if (e.target instanceof HTMLSelectElement) {
				this.source = e.target.value;
				this.requestUpdate();
			}
		}}>${nics.map((n) => html`<option .selected=${n === source}>${n}</option>`)}</select></label><label>Destination<select class="field" @change=${(
			e: Event,
		) => {
			if (e.target instanceof HTMLSelectElement) {
				this.destination = e.target.value;
				this.requestUpdate();
			}
		}}>${[...dest, "none"].map((n) => html`<option value=${n} .selected=${n === to}>${n === "none" ? "Unplug" : n}</option>`)}</select></label><button class="button primary" ?disabled=${!source}>${to === "none" ? "Unplug" : "Connect"}</button></form>`;
	}
	private sshGuide() {
		const { cli, rail, machines } = this.lab;
		const machine = rail.find((name) => machines[name]?.life.phase === "ready");
		const command = location.origin === LIVE_LAB_URL ? CLI_COMMAND : `${CLI_COMMAND} --origin ${location.origin}`;
		return html`<article class="dt-guide"><div class="dt-guide-status"><b>${selectCliSegment(this.lab).text}</b><button class="button" @click=${() => this.app.link.set(cli.kind === "off")}>${cli.kind === "off" ? "Turn link on" : "Turn link off"}</button></div>
		<h3>On your computer</h3><p>${cliGuidance(cli)}</p><pre><code>${command}</code></pre>
		<h3>At the unlab&gt; prompt</h3>${machine ? html`<p>Open a shell in ${machine}.</p><pre><code>ssh ${machine}</code></pre>` : html`<p>Boot a machine in Rack Manager, then use its name here.</p>`}
		<p class="dt-guide-note">Keep the tab and CLI open during your session. You’ll need Node.js 22.12 or later and OpenSSH on Linux or macOS.</p>
		<a href=${`${REPO_URL}#reach-the-lab-from-your-terminal`} target="_blank" rel="noopener noreferrer">SSH setup, file transfers and troubleshooting ↗</a></article>`;
	}
	private about() {
		return html`<article class="dt-guide"><div class="dt-about-brand">${launcherMark}<h2>unLAB</h2></div>
		<p>A Linux network lab in your browser. Boot guests, wire them to virtual switches, and watch the packets move between them.</p>
		<p>Built by <a href=${AUTHOR_URL} target="_blank" rel="noopener noreferrer">Greg Bell</a> with <a href="https://unkernel.dev/" target="_blank" rel="noopener noreferrer">unkernel</a>, the WebAssembly Linux runtime by Pooya Parsa and contributors.</p>
		<div class="dt-about-links"><a href=${REPO_URL} target="_blank" rel="noopener noreferrer">Source on GitHub ↗</a><a href=${X_URL} target="_blank" rel="noopener noreferrer">${X_ACCOUNT} on X ↗</a></div>
		<unlab-whats-new inline></unlab-whats-new></article>`;
	}
	private content(w: Win) {
		switch (w.kind) {
			case "switch-details":
				return this.switchDetails(w.name);
			case "inspector":
				return html`<unlab-capture mode="full"></unlab-capture>`;
			case "config": {
				const machine = this.lab.machines[w.name];
				return machine ? this.configuration(machine) : nothing;
			}
			case "topology":
				return this.topologyBody();
			case "rack":
				return this.rackBody();
			case "welcome":
				return html`<unlab-spawn-form .customize=${(choice: SpawnChoice) => {
					this.initialChoice = choice;
					this.launch("spawn");
				}}></unlab-spawn-form>`;
			case "spawn":
				return html`<unlab-machine-wizard .initialChoice=${this.initialChoice}></unlab-machine-wizard>`;
			case "ssh":
				return this.sshGuide();
			case "about":
				return this.about();
			case "agent":
				return html`<unlab-agent-panel></unlab-agent-panel>`;
			case "switch":
				return html`<form class="dt-form" @submit=${async (e: SubmitEvent) => {
					e.preventDefault();
					if (!(e.currentTarget instanceof HTMLFormElement)) return;
					const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
					if (await this.run(`mkswitch ${name}`.trim())) {
						this.dismissUtility("switch");
						this.showRack();
					}
				}}><label>Switch name<input class="field" name="name" placeholder="Automatic" autocomplete="off"></label><button class="button primary">Add switch</button></form>`;
			case "patch":
				return this.patchForm();
			case "note":
				return html`<textarea class="dt-notepad" aria-label="Note text" placeholder="Write a note…" .value=${w.text} @input=${(
					e: Event,
				) => {
					if (e.target instanceof HTMLTextAreaElement) {
						w.text = e.target.value;
						this.save();
					}
				}}></textarea>`;
			case "capture":
				return html`<unlab-capture mode="dock" on-switch=${w.on}></unlab-capture>`;
			case "console": {
				const ref = parseSessionId(w.session),
					m = ref && this.lab.machines[ref.machine];
				return ref && this.lab.sessions[ref.session]
					? html`<unlab-terminal .session=${ref.session} .visible=${visible(w) || this.flights.has(w.id)} .focused=${m?.life.phase === "ready" && visible(w) && this.typing === w.id && this.lab.keyboard.kind !== "bar"}></unlab-terminal>`
					: html`<p class="dt-pending">${m?.life.phase ?? "Opening terminal"}</p>`;
			}
		}
	}
	private hue(w: Win) {
		const ref = w.kind === "console" ? parseSessionId(w.session) : null;
		return ref ? (this.lab.machines[ref.machine]?.hue ?? nothing) : nothing;
	}
	private frame(w: Win) {
		const ref = w.kind === "console" ? parseSessionId(w.session) : null,
			m = ref && this.lab.machines[ref.machine],
			title = w.kind === "console" ? (m?.name ?? w.session) : w.kind === "capture" ? "Packet capture" : label(w);
		return html`<section class="dt-window" tabindex="-1" aria-label=${label(w)} data-window=${w.id} data-kind=${w.kind} data-active=${this.active === w.id} data-max=${w.state === "max"} data-hue=${m?.hue ?? nothing} ?hidden=${!visible(w) && !this.flights.has(w.id)} ?inert=${!visible(w)} style=${`${rect(this.box(w))};z-index:${this.flights.has(w.id) ? Math.max(...this.windows.map((w) => w.z)) + 1 : w.z}`} @pointerdown=${(e: PointerEvent) => this.handleDown(e, w)}>
		<header class="dt-title" tabindex="0" @dblclick=${(e: MouseEvent) => {
			if (e.target instanceof Element && !e.target.closest("button")) this.maximise(w);
		}}>${icon(mark(w))}<b>${title}</b>${ref ? html`<span class="dt-session">${ref.shell ? `terminal ${ref.shell}` : "terminal"}</span>` : nothing}
		<span class="dt-meta">${m ? addressText(m) : w.kind === "capture" ? w.on : ""}</span>
		<button class="icon" aria-label=${`Minimize ${label(w)}`} title="Minimize" @click=${() => this.minimise(w)}>${parkIcon}</button><button class="icon" aria-label=${`${w.state === "max" ? "Restore" : "Maximize"} ${label(w)}`} title=${w.state === "max" ? "Restore" : "Maximize"} @click=${() => this.maximise(w)}>${w.state === "max" ? restoreIcon : maximiseIcon}</button><button class="icon dt-close" aria-label=${`Close ${label(w)}`} title="Close window" @click=${() => this.close(w)}>${closeIcon}</button></header>
		<div class="dt-interior">${this.content(w)}</div>${w.state === "open" ? edges.map((d) => html`<i data-edge=${d}></i>`) : nothing}</section>`;
	}
	override render() {
		const minimized = this.windows.filter((w) => w.state === "mini");
		return html`<header class="dt-panel"><div class="dt-launcher"><button class="dt-logo" aria-label="Lab menu" aria-haspopup="menu" aria-expanded=${!!this.menu} @click=${() => this.openMenu(this.menu ? null : "main")} title="unLAB menu">${launcherMark}</button>${this.menuView()}</div><unlab-command-bar idle-placeholder="Command palette"></unlab-command-bar>${this.status()}</header>
		<main class="dt-work" tabindex="-1" @contextmenu=${this.openContext} aria-label="Lab desktop" data-docked=${minimized.length > 0} data-animating=${this.flights.size > 0}>${this.snap ? html`<div class="dt-snap" data-side=${this.snap}></div>` : nothing}${repeat(
			this.windows,
			(w) => w.id,
			(w) => this.frame(w),
		)}</main>
		<nav class="dt-dock" aria-label="Minimized windows" ?hidden=${!minimized.length}>${minimized.map(
			(w) =>
				html`<button data-restore=${w.id} data-hue=${this.hue(w)} title=${`Restore ${label(w)}`} aria-label=${`Restore ${label(w)} from dock`} data-kind=${w.kind} @click=${() => this.raise(w, true)}>${icon(mark(w))}<span>${w.kind === "console" ? terminalLabel(w.session, true) : label(w)}</span></button>`,
		)}</nav>${this.contextView()}
		${this.notice ? html`<div class="dt-toast" role="status">${this.notice}</div>` : nothing}`;
	}
}
customElements.define("unlab-desktop", Desktop);
