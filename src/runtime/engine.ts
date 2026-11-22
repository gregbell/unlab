// The effect executor. It performs what the model asks (boot, stop, plug, cut,
// open, publish) on live workers, the switch and the screens, and reports what
// happened as runtime events. It decides nothing: names, ports, lifecycle and
// timeouts are the model's.
//
// Bytes and frames never reach the store. Per chunk: vm → screen (which scans
// it for the shell's marks) → at most a phase event. Per frame: vm → switch →
// the neighbours' vms, and the tap → capture log.
//
// The engine may dispatch from inside run(), so the store must queue an event
// dispatched while it is still running the effects of the previous one.

import type { CaptureLog } from "../capture/index.ts";
import type { ExecOutcome, ExecPort } from "../commands/index.ts";
import type { Effect, HostEntry, MachineName, PortNo, RuntimeEvent, SessionId } from "../model/index.ts";
import type { LineMark, Screen, Screens } from "./screens.ts";
import type { ShellEvent } from "./shell-tracker.ts";
import type { LabSwitch, MacEntry, PortCounters } from "./switch.ts";
import { DEFAULT_TTY_SIZE, type StartVm, type Tty, type Vm, type VmRef, type VmSink } from "./vm.ts";

export type { ExecOutcome, ExecPort };

/** What the engine needs from the store. */
export interface RuntimeStore {
	dispatchRuntime(event: RuntimeEvent): void;
}

/** A line the engine would not type, as a sentence for the result block. */
export class ExecRefused extends Error {
	override readonly name = "ExecRefused";
}

/** Switch facts the model does not hold. Read them on a tick while they are on screen. */
export interface RuntimeReads {
	macTable(): readonly MacEntry[];
	counters(port: PortNo): PortCounters | undefined;
}

export interface Engine {
	run(effect: Effect): void;
	readonly exec: ExecPort;
	readonly screens: Screens;
	readonly capture: CaptureLog;
	readonly reads: RuntimeReads;
	/** Stop every machine and the clock. Reports nothing. */
	dispose(): void;
}

export interface EngineDeps {
	readonly store: RuntimeStore;
	readonly sw: LabSwitch;
	readonly capture: CaptureLog;
	readonly screens: Screens;
	readonly startVm: StartVm;
	/** Image bytes by manifest name, fetched once however many machines ask. Rejects, never throws. */
	readonly image: (name: string) => Promise<ArrayBufferLike>;
	/** The page's one polite live region. */
	readonly announce: (text: string) => void;
	/** Run fn every ms until the returned function is called. */
	readonly every: (ms: number, fn: () => void) => () => void;
	/** ms since the lab started: the capture log's clock and the model's. */
	readonly now: () => number;
}

interface VmEntry {
	readonly attempt: number;
	readonly vm: Vm;
	/** `over` has failed and waits to be stopped. Only booting and ready vms are listened to. */
	phase: "booting" | "ready" | "over" | "stopping";
	/** The table the guest was last given. */
	hosts: readonly HostEntry[];
}

/** An injected line, from the call to its result. */
interface Injection {
	/** The shell reported a command finished. It is this line's only once the line has been typed. */
	finish(exitCode: number | null): void;
	fail(reason: unknown): void;
}

interface SessionEntry {
	readonly id: SessionId;
	readonly machine: MachineName;
	readonly tty: Tty;
	readonly screen: Screen;
	/** A console is open for its machine's life. A shell is open from its pty's ready to its exit. */
	state: "closed" | "opening" | "open";
	/** The one line being typed or awaited. A shell runs one command at a time. */
	injection: Injection | null;
}

const isMachineName = (s: string): s is MachineName => /^node\d+$/.test(s);

function parseSession(id: SessionId): { machine: MachineName; tty: Tty } | null {
	const colon = id.indexOf(":");
	const machine = id.slice(0, colon);
	const tab = id.slice(colon + 1);
	if (!isMachineName(machine)) return null;
	return { machine, tty: tab === "console" ? "console" : Number(tab.slice(2)) };
}

const sameHosts = (a: readonly HostEntry[], b: readonly HostEntry[]): boolean =>
	a.length === b.length && a.every((h, i) => h.ip === b[i].ip && h.name === b[i].name);

const lastLineOf = (output: string): string => output.split("\n").findLast((line) => line.trim() !== "") ?? "";

export function createEngine(deps: EngineDeps): Engine {
	const { sw, capture, screens } = deps;
	const dispatch = (event: RuntimeEvent) => deps.store.dispatchRuntime(event);

	const vms = new Map<MachineName, VmEntry>();
	const sessions = new Map<SessionId, SessionEntry>();
	const ports = new Map<PortNo, MachineName>();
	let published: readonly HostEntry[] | null = null;
	let clock: { readonly hz: 1 | 10; readonly stop: () => void } | null = null;

	const untap = sw.onTap((e) => capture.appendFrame(e));

	/** The vm a report came from, if it is still the one being listened to. */
	const listening = (ref: VmRef): VmEntry | undefined => {
		const entry = vms.get(ref.machine);
		return entry && entry.attempt === ref.attempt && (entry.phase === "booting" || entry.phase === "ready")
			? entry
			: undefined;
	};

	const readyVm = (machine: MachineName): Vm | undefined => {
		const entry = vms.get(machine);
		return entry?.phase === "ready" ? entry.vm : undefined;
	};

	const shellEvents = (s: SessionEntry, events: readonly ShellEvent[]) => {
		for (const e of events) {
			if (e.kind === "phase") dispatch({ type: "session/shell", session: s.id, shell: e.phase });
			else s.injection?.finish(e.exitCode);
		}
	};

	const output = (session: SessionId, bytes: Uint8Array) => {
		const s = sessions.get(session);
		if (s) shellEvents(s, s.screen.write(bytes));
	};

	/** Send to the guest what was typed, pasted or answered by the terminal. */
	const send = (s: SessionEntry, vm: Vm, data: string) => {
		vm.write(s.tty, data);
		if (data.includes("\r")) shellEvents(s, s.screen.submitted());
	};

	const abandon = (s: SessionEntry) => {
		s.injection?.fail(new ExecRefused(`${s.id} closed before the command returned.`));
	};

	/** Why a line cannot be typed into the session now, or null when it can. */
	const refusal = (s: SessionEntry | undefined, id: SessionId): ExecRefused | null => {
		if (s?.state !== "open" || !readyVm(s.machine)) return new ExecRefused(`${id} is not open.`);
		// Only a shell at a prompt can be told when its next command ends.
		if (s.screen.shell === "unknown") return new ExecRefused(`${id} has not shown a prompt yet.`);
		if (s.screen.shell === "running" || s.injection) return new ExecRefused(`${id} is running a program.`);
		return null;
	};

	/** The machine's worker is gone or going: nothing is waiting on its sessions, and its shells have ended. */
	const endSessions = (machine: MachineName) => {
		for (const s of sessions.values()) {
			if (s.machine !== machine) continue;
			abandon(s);
			if (s.tty === "console" || s.state === "closed") continue;
			s.state = "closed";
			dispatch({ type: "session/ended", session: s.id });
		}
	};

	const sink: VmSink = {
		stage(ref, stage) {
			if (listening(ref)) dispatch({ type: "vm/stage", ...ref, stage });
		},
		ready(ref, bootMs) {
			const entry = listening(ref);
			if (!entry) return;
			entry.phase = "ready";
			if (published && !sameHosts(published, entry.hosts)) {
				entry.hosts = published;
				entry.vm.reconfigure(published);
			}
			dispatch({ type: "vm/ready", ...ref, bootMs });
		},
		failed(ref, reason) {
			const entry = listening(ref);
			if (!entry) return;
			entry.phase = "over";
			endSessions(ref.machine);
			dispatch({ type: "vm/failed", ...ref, reason });
		},
		frame(ref, frame) {
			if (!listening(ref)) return;
			for (const [port, machine] of ports) {
				if (machine !== ref.machine) continue;
				sw.receive(port, frame);
				return;
			}
		},
		consoleBytes(ref, bytes) {
			if (listening(ref)) output(`${ref.machine}:console`, bytes);
		},
		ptyOpened(ref, pty) {
			const entry = listening(ref);
			const s = sessions.get(`${ref.machine}:sh${pty}`);
			if (!entry || s?.state !== "opening") return;
			s.state = "open";
			// The screen may have been fitted while the pty was opening, when the guest could not be told.
			entry.vm.resize(s.tty, s.screen.size.cols, s.screen.size.rows);
			dispatch({ type: "session/opened", session: s.id });
		},
		ptyBytes(ref, pty, bytes) {
			if (listening(ref)) output(`${ref.machine}:sh${pty}`, bytes);
		},
		ptyExited(ref, pty) {
			const s = sessions.get(`${ref.machine}:sh${pty}`);
			if (!listening(ref) || !s || s.state === "closed") return;
			s.state = "closed";
			abandon(s);
			dispatch({ type: "session/ended", session: s.id });
		},
	};

	const createSession = (id: SessionId) => {
		const parsed = parseSession(id);
		if (!parsed || sessions.has(id)) return;
		const s: SessionEntry = {
			id,
			...parsed,
			state: parsed.tty === "console" ? "open" : "closed",
			injection: null,
			screen: screens.create(id, {
				input(data) {
					const vm = readyVm(s.machine);
					if (!vm || s.state !== "open") return;
					send(s, vm, data);
				},
				resize(cols, rows) {
					const entry = vms.get(s.machine);
					if (entry && entry.phase !== "stopping" && s.state === "open") entry.vm.resize(s.tty, cols, rows);
				},
			}),
		};
		sessions.set(id, s);
	};

	const tick = () => {
		const now = deps.now();
		capture.sweep(now);
		dispatch({ type: "tick", now });
	};

	function run(effect: Effect): void {
		switch (effect.type) {
			case "vm/boot": {
				const { machine, attempt, config } = effect;
				const previous = vms.get(machine);
				if (previous && previous.attempt >= attempt) return;
				if (previous) {
					endSessions(machine);
					void previous.vm.stop();
				}
				const size = sessions.get(`${machine}:console`)?.screen.size ?? DEFAULT_TTY_SIZE;
				const vm = deps.startVm(
					{ machine, attempt, config, cols: size.cols, rows: size.rows, image: deps.image(config.spec.image) },
					sink,
				);
				vms.set(machine, { attempt, vm, phase: "booting", hosts: config.hosts });
				return;
			}
			case "vm/stop": {
				const { machine, attempt } = effect;
				const entry = vms.get(machine);
				if (!entry) {
					dispatch({ type: "vm/stopped", machine, attempt });
					return;
				}
				if (attempt < entry.attempt || entry.phase === "stopping") return;
				entry.phase = "stopping";
				endSessions(machine);
				void entry.vm.stop().then(() => {
					if (vms.get(machine) === entry) vms.delete(machine);
					dispatch({ type: "vm/stopped", machine, attempt });
				});
				return;
			}
			case "port/attach": {
				const { port, machine } = effect;
				if (ports.get(port) === machine) return;
				sw.detach(port);
				ports.set(port, machine);
				sw.attach(port, {
					deliver(frame) {
						const entry = vms.get(machine);
						if (entry && entry.phase !== "stopping") entry.vm.deliver(frame);
					},
				});
				return;
			}
			case "port/detach":
				ports.delete(effect.port);
				sw.detach(effect.port);
				return;
			case "link/set": {
				const { port, machine, up, cause } = effect;
				sw.setLink(port, up);
				capture.appendLink({ port, machine, up, cause });
				return;
			}
			case "pty/open": {
				const s = sessions.get(effect.session);
				if (!s || s.tty === "console" || s.state !== "closed") return;
				const entry = vms.get(s.machine);
				if (!entry || entry.phase === "over" || entry.phase === "stopping") {
					dispatch({ type: "session/ended", session: s.id });
					return;
				}
				s.state = "opening";
				entry.vm.openPty(s.tty, s.screen.size.cols, s.screen.size.rows);
				return;
			}
			case "pty/close": {
				const s = sessions.get(effect.session);
				if (!s || s.tty === "console" || s.state === "closed") return;
				s.state = "closed";
				abandon(s);
				vms.get(s.machine)?.vm.closePty(s.tty);
				dispatch({ type: "session/ended", session: s.id });
				return;
			}
			case "screen/create":
				createSession(effect.session);
				return;
			case "screen/dispose": {
				const s = sessions.get(effect.session);
				if (s) abandon(s);
				sessions.delete(effect.session);
				screens.dispose(effect.session);
				return;
			}
			case "hosts/publish":
				published = effect.hosts;
				for (const entry of vms.values()) {
					if (entry.phase !== "ready" || sameHosts(published, entry.hosts)) continue;
					entry.hosts = published;
					entry.vm.reconfigure(published);
				}
				return;
			case "capture/clear":
				capture.clear();
				return;
			case "announce":
				deps.announce(effect.text);
				return;
			case "clock":
				if (clock?.hz === effect.hz) return;
				clock?.stop();
				clock = { hz: effect.hz, stop: deps.every(1000 / effect.hz, tick) };
				return;
			default:
				effect satisfies never;
		}
	}

	const exec: ExecPort = {
		inject(session, line, source, signal) {
			return new Promise<ExecOutcome>((resolve, reject) => {
				const s = sessions.get(session);
				const refused = refusal(s, session);
				if (!s || refused) {
					reject(refused);
					return;
				}
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}

				const startedAt = deps.now();
				/** Set when the line is typed. */
				let mark: LineMark | null = null;

				const over = () => {
					signal.removeEventListener("abort", aborted);
					mark?.end();
					if (s.injection === injection) s.injection = null;
				};
				const injection: Injection = {
					finish(exitCode) {
						const typed = mark;
						if (!typed) return;
						over();
						const output = typed.output();
						resolve({ exitCode, output, lastLine: lastLineOf(output), ms: Math.round(deps.now() - startedAt) });
					},
					fail(reason) {
						over();
						reject(reason);
					},
				};
				function aborted() {
					injection.fail(signal.reason);
				}
				const type = () => {
					s.injection = null;
					const vm = readyVm(s.machine);
					const changed = refusal(s, session);
					if (!vm || changed) {
						injection.fail(changed);
						return;
					}
					s.injection = injection;
					mark = s.screen.beginMark(source === "agent" ? "agent" : "bar");
					if (source === "agent") dispatch({ type: "session/marked", session, source: "agent" });
					send(s, vm, `${line}\r`);
				};

				signal.addEventListener("abort", aborted, { once: true });
				s.injection = injection;
				type();
			});
		},
	};

	return {
		run,
		exec,
		screens,
		capture,
		reads: {
			macTable: () => sw.macTable(),
			counters: (port) => sw.counters(port),
		},
		dispose() {
			clock?.stop();
			clock = null;
			untap();
			for (const port of ports.keys()) sw.detach(port);
			ports.clear();
			for (const entry of vms.values()) void entry.vm.stop();
			vms.clear();
			for (const s of sessions.values()) {
				abandon(s);
				screens.dispose(s.id);
			}
			sessions.clear();
		},
	};
}
