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
import type { ExecOutcome, ExecPort, FileOutcome, FilePort } from "../commands/index.ts";
import {
	type DiskCopy,
	type Effect,
	type HostEntry,
	type MachineName,
	type NicRef,
	type PortNo,
	parseSessionId,
	type RuntimeEvent,
	type SessionId,
	type StopHow,
} from "../model/index.ts";
import type { CopyJob, CopyReport } from "./protocol.ts";
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
	readonly files: FilePort;
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
	/** Delete those sets of machine n's disks, however many disks it has. */
	readonly deleteDisks: (n: number, sets: readonly number[]) => void;
	/** Copy disks that no guest has open. Returns what drops the copy, which then reports nothing and leaves what it wrote. */
	readonly startCopy: (job: CopyJob, on: (report: CopyReport) => void) => () => void;
	/** The page's one polite live region. */
	readonly announce: (text: string) => void;
	/** Run fn every ms until the returned function is called. */
	readonly every: (ms: number, fn: () => void) => () => void;
	/** ms since the lab started: the capture log's clock and the model's. */
	readonly now: () => number;
	/** A fresh secret per boot for the guest prompt's marks. Hex. */
	readonly promptToken: () => string;
}

interface VmEntry {
	readonly attempt: number;
	readonly vm: Vm;
	/**
	 * `over` has failed and waits to be stopped. `ending` saves its disks, and
	 * its guest may still be shutting down. Only booting and ready vms take
	 * anything, and an ending one is still heard.
	 */
	phase: "booting" | "ready" | "over" | "ending" | "dropped";
	/** The table the guest was last given. */
	hosts: readonly HostEntry[];
	/** Every prompt this boot's shells print carries it. */
	readonly promptToken: string;
	/** Shells the guest took away. It is going down, or it will not say why. */
	readonly lost: SessionId[];
	/** The copy of its disks that it is making. */
	saving: DiskCopy | null;
	stopped: Promise<void> | null;
	/** The files it is writing, by id. */
	readonly writes: Map<number, Write>;
}

/** A file that a guest has been given to write. */
interface Write {
	readonly path: string;
	settle(outcome: FileOutcome): void;
}

/** A copy of disks that no guest has open, or that waits until none has. */
interface Job {
	drop(): void;
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
	/** The person has typed at this prompt and not yet run or cancelled it. */
	drafting: boolean;
	/** The tick since which the shell has owed a typed-ahead line and nothing has come in or gone out. */
	quietSince: number | null;
}

/** A shell that has a typed-ahead line echoes it within milliseconds of its prompt. */
const QUIET_MS = 1000;

/** What a terminal sends on its own to answer the guest: cursor, status and device reports, focus, colours. */
function isTerminalReply(data: string): boolean {
	const esc = "\x1b";
	if (data.startsWith(`${esc}]`)) return data.endsWith("\x07") || data.endsWith(`${esc}\\`);
	if (!data.startsWith(`${esc}[`)) return false;
	const body = data.slice(2);
	return body === "I" || body === "O" || /^\??[\d;]*[Rcn]$/.test(body);
}

const sameHosts = (a: readonly HostEntry[], b: readonly HostEntry[]): boolean =>
	a.length === b.length && a.every((h, i) => h.ip === b[i].ip && h.name === b[i].name);

/** Why a command that a stop cut off did not return. */
const STOPPED_FOR: Partial<Record<StopHow, (machine: MachineName) => string>> = {
	off: (machine) => `${machine} powered off`,
	reboot: (machine) => `${machine} rebooted`,
};

const lastLineOf = (output: string): string => output.split("\n").findLast((line) => line.trim() !== "") ?? "";

export function createEngine(deps: EngineDeps): Engine {
	const { sw, capture, screens } = deps;
	const dispatch = (event: RuntimeEvent) => deps.store.dispatchRuntime(event);

	const vms = new Map<MachineName, VmEntry>();
	const sessions = new Map<SessionId, SessionEntry>();
	const jobs = new Map<MachineName, Job>();
	const ports = new Map<PortNo, NicRef>();
	let published: readonly HostEntry[] | null = null;
	let writes = 0;
	let clock: { readonly hz: 1 | 10; readonly stop: () => void } | null = null;

	const untap = sw.onTap((e) => capture.appendFrame(e));

	/** The vm a report came from, if it is still the one being listened to. */
	const listening = (ref: VmRef): VmEntry | undefined => {
		const entry = vms.get(ref.machine);
		return entry && entry.attempt === ref.attempt && (entry.phase === "booting" || entry.phase === "ready")
			? entry
			: undefined;
	};

	/** The vm a guest's bytes came from, if it is still running or ending. */
	const heard = (ref: VmRef): VmEntry | undefined => {
		const entry = vms.get(ref.machine);
		return listening(ref) ?? (entry?.attempt === ref.attempt && entry.phase === "ending" ? entry : undefined);
	};

	const readyVm = (machine: MachineName): Vm | undefined => {
		const entry = vms.get(machine);
		return entry?.phase === "ready" ? entry.vm : undefined;
	};

	const shellEvents = (s: SessionEntry, events: readonly ShellEvent[]) => {
		for (const e of events) {
			if (e.kind === "phase") {
				if (e.phase === "prompt") s.drafting = false;
				dispatch({ type: "session/shell", session: s.id, shell: e.phase });
			} else {
				// What was typed until now went to the command.
				s.drafting = false;
				s.injection?.finish(e.exitCode);
			}
		}
	};

	const output = (session: SessionId, bytes: Uint8Array) => {
		const s = sessions.get(session);
		if (!s) return;
		s.quietSince = null;
		const events = s.screen.write(bytes);
		// A prompt that a guest prints as it goes down is not one to type at.
		if (vms.get(s.machine)?.phase !== "ending") shellEvents(s, events);
	};

	/** Send to the guest what was typed, pasted or answered by the terminal. */
	const send = (s: SessionEntry, vm: Vm, data: string) => {
		s.quietSince = null;
		vm.write(s.tty, data);
		if (data.includes("\r")) shellEvents(s, s.screen.submitted());
	};

	const endWrites = (entry: VmEntry | undefined, why: string) => {
		for (const { path, settle } of entry?.writes.values() ?? []) {
			settle({ kind: "unsure", reason: `${why} while ${path} was being written, so check whether it was.` });
		}
	};

	const abandon = (s: SessionEntry, why = `${s.id} closed`) => {
		s.injection?.fail(new ExecRefused(`${why} before the command returned.`));
	};

	/** Why a line cannot be typed into the session now, or null when it can. */
	const refusal = (s: SessionEntry | undefined, id: SessionId): ExecRefused | null => {
		if (s?.state !== "open" || !readyVm(s.machine))
			return new ExecRefused(`${id} is not open, so use another session.`);
		// Only a shell at a prompt can be told when its next command ends.
		if (s.screen.shell === "unknown") return new ExecRefused(`${id} has not shown a prompt yet, so wait until it has.`);
		if (s.screen.shell === "running" || s.injection)
			return new ExecRefused(`${id} is running a program, so wait until it ends.`);
		if (s.drafting) return new ExecRefused(`${id} has a half-typed line, so finish it there or use another session.`);
		return null;
	};

	/** The machine's worker is gone or going: nothing is waiting on it, and its shells have ended. */
	const endSessions = (machine: MachineName, why?: string) => {
		endWrites(vms.get(machine), why ?? `${machine} stopped`);
		for (const s of sessions.values()) {
			if (s.machine !== machine) continue;
			abandon(s, why);
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
			const entry = heard(ref);
			if (!entry) return;
			if (entry.phase !== "ending") entry.phase = "over";
			endSessions(ref.machine);
			dispatch({ type: "vm/failed", ...ref, reason });
		},
		halted(ref, next) {
			const entry = listening(ref);
			if (!entry) return;
			endSessions(ref.machine, STOPPED_FOR[next]?.(ref.machine));
			dispatch({ type: "vm/halted", ...ref, next, closed: entry.lost });
		},
		copied(ref, report) {
			const entry = listening(ref);
			// What a guest that has gone down goes on to report is deleted once its worker is gone.
			if (!entry?.saving) return;
			const copy = entry.saving;
			if (report.kind !== "progress") entry.saving = null;
			reportSave(copy, report);
		},
		wrote(ref, id, outcome) {
			if (listening(ref)) vms.get(ref.machine)?.writes.get(id)?.settle(outcome);
		},
		nicLost(ref, nic, reason) {
			if (listening(ref)) dispatch({ type: "vm/nic-lost", ...ref, nic, reason });
		},
		frame(ref, nic, frame) {
			if (!heard(ref)) return;
			for (const [port, plugged] of ports) {
				if (plugged.machine !== ref.machine || plugged.nic !== nic) continue;
				sw.receive(port, frame);
				return;
			}
		},
		consoleBytes(ref, bytes) {
			if (heard(ref)) output(`${ref.machine}:console`, bytes);
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
		ptyExited(ref, pty, lost) {
			const s = sessions.get(`${ref.machine}:sh${pty}`);
			const entry = listening(ref);
			if (!entry || !s || s.state === "closed") return;
			s.state = "closed";
			if (lost) entry.lost.push(s.id);
			abandon(s);
			dispatch({ type: "session/ended", session: s.id });
		},
	};

	/** What became of a checkpoint, whoever copied it. */
	const reportSave = ({ machine, attempt, to: set }: DiskCopy, report: CopyReport) => {
		switch (report.kind) {
			case "progress":
				dispatch({ type: "checkpoint/progress", machine, attempt, set, percent: report.percent });
				return;
			case "done":
				dispatch({ type: "checkpoint/saved", machine, attempt, set, bytes: report.bytes });
				return;
			case "failed":
				dispatch({ type: "checkpoint/unsaved", machine, attempt, set, reason: report.reason });
				return;
		}
	};

	const reportRestore = ({ machine, attempt, to: set }: DiskCopy, report: CopyReport) => {
		switch (report.kind) {
			case "progress":
				dispatch({ type: "checkpoint/progress", machine, attempt, set, percent: report.percent });
				return;
			case "done":
				dispatch({ type: "checkpoint/restored", machine, attempt, set, at: deps.now() });
				return;
			case "failed":
				dispatch({ type: "vm/failed", machine, attempt, reason: report.reason });
				return;
		}
	};

	const startJob = (job: CopyJob, released: Promise<void> | undefined) => {
		const { copy, why } = job;
		const { machine, n, to } = copy;
		let drop: (() => void) | null = null;
		const entry: Job = {
			drop() {
				jobs.delete(machine);
				drop?.();
				deps.deleteDisks(n, [to]);
			},
		};
		jobs.set(machine, entry);
		const start = () => {
			if (jobs.get(machine) !== entry) return;
			drop = deps.startCopy(job, (report) => {
				if (jobs.get(machine) !== entry) return;
				if (report.kind !== "progress") jobs.delete(machine);
				(why === "save" ? reportSave : reportRestore)(copy, report);
			});
		};
		if (released) void released.then(start);
		else start();
	};

	const createSession = (id: SessionId) => {
		const parsed = parseSessionId(id);
		if (!parsed || sessions.has(id)) return;
		const s: SessionEntry = {
			id,
			machine: parsed.machine,
			tty: parsed.shell ?? "console",
			state: parsed.shell === null ? "open" : "closed",
			injection: null,
			drafting: false,
			quietSince: null,
			screen: screens.create(id, {
				input(data) {
					const vm = readyVm(s.machine);
					if (!vm || s.state !== "open") return;
					if (!isTerminalReply(data)) s.drafting = !data.includes("\r") && !data.includes("\x03");
					send(s, vm, data);
				},
				resize(cols, rows) {
					const entry = vms.get(s.machine);
					if (entry && entry.phase !== "dropped" && s.state === "open") entry.vm.resize(s.tty, cols, rows);
				},
			}),
		};
		sessions.set(id, s);
		const booted = vms.get(parsed.machine);
		if (booted) s.screen.expectPromptToken(booted.promptToken);
	};

	/** A program can read a line typed ahead for the shell. Then no echo comes, and the shell is at its prompt. */
	const settleQuiet = (now: number) => {
		for (const s of sessions.values()) {
			if (!s.screen.expectsTypedAhead) {
				s.quietSince = null;
				continue;
			}
			s.quietSince ??= now;
			if (now - s.quietSince < QUIET_MS) continue;
			s.quietSince = null;
			// Anything typed since the prompt is still on the line, unlike at a fresh prompt.
			const { drafting } = s;
			shellEvents(s, s.screen.settle());
			s.drafting = drafting;
		}
	};

	const tick = () => {
		const now = deps.now();
		capture.sweep(now);
		settleQuiet(now);
		dispatch({ type: "tick", now });
	};

	function run(effect: Effect): void {
		switch (effect.type) {
			case "vm/boot": {
				const { machine, attempt, config } = effect;
				const previous = vms.get(machine);
				if (previous && previous.attempt >= attempt) return;
				if (previous) endSessions(machine);
				const released = previous?.vm.stop("save") ?? Promise.resolve();
				const console = sessions.get(`${machine}:console`);
				const size = console?.screen.size ?? DEFAULT_TTY_SIZE;
				const promptToken = deps.promptToken();
				if (console) {
					console.drafting = false;
					console.quietSince = null;
					console.screen.expectPromptToken(promptToken);
				}
				const image = deps.image(config.spec.image);
				const vm = deps.startVm(
					{ machine, attempt, config, cols: size.cols, rows: size.rows, image, released, promptToken },
					sink,
				);
				const { hosts } = config;
				vms.set(machine, {
					attempt,
					vm,
					phase: "booting",
					hosts,
					promptToken,
					lost: [],
					saving: null,
					stopped: null,
					writes: new Map(),
				});
				return;
			}
			case "vm/stop": {
				const { machine, attempt, how } = effect;
				jobs.get(machine)?.drop();
				const entry = vms.get(machine);
				if (!entry) {
					dispatch({ type: "vm/stopped", machine, attempt, clean: true, at: deps.now() });
					return;
				}
				if (attempt < entry.attempt || entry.phase === "dropped") return;
				if (how !== "drop" && entry.phase === "ending") return;
				entry.phase = how === "drop" ? "dropped" : "ending";
				endSessions(machine, STOPPED_FOR[how]?.(machine));
				const stopped = entry.vm.stop(how);
				entry.stopped ??= stopped.then((clean) => {
					if (vms.get(machine) === entry) vms.delete(machine);
					if (entry.saving) deps.deleteDisks(entry.saving.n, [entry.saving.to]);
					dispatch({ type: "vm/stopped", machine, attempt, clean, at: deps.now() });
				});
				return;
			}
			case "disks/delete":
				deps.deleteDisks(effect.n, effect.sets);
				return;
			case "checkpoint/save": {
				const { copy } = effect;
				const entry = vms.get(copy.machine);
				if (!entry) {
					startJob({ copy, why: "save" }, undefined);
				} else if (entry.phase === "ready") {
					entry.saving = copy;
					entry.vm.checkpoint(copy);
				} else {
					reportSave(copy, {
						kind: "failed",
						reason: `${copy.machine} stopped before checkpoint ${copy.checkpoint} was saved.`,
					});
				}
				return;
			}
			case "checkpoint/restore":
				startJob({ copy: effect.copy, why: "restore" }, vms.get(effect.copy.machine)?.stopped ?? undefined);
				return;
			case "port/attach": {
				const { port, machine, nic } = effect;
				const held = ports.get(port);
				if (held?.machine === machine && held.nic === nic) return;
				sw.detach(port);
				ports.set(port, { machine, nic });
				sw.attach(port, {
					deliver(frame) {
						const entry = vms.get(machine);
						if (entry && entry.phase !== "dropped") entry.vm.deliver(nic, frame);
					},
				});
				// Reserved, not live: the model raises the link when the machine is ready.
				sw.setLink(port, false);
				return;
			}
			case "port/detach":
				ports.delete(effect.port);
				sw.detach(effect.port);
				return;
			case "link/set": {
				const { port, machine, nic, up, cause } = effect;
				sw.setLink(port, up);
				capture.appendLink({ port, machine, nic, up, cause });
				return;
			}
			case "pty/open": {
				const s = sessions.get(effect.session);
				if (!s || s.tty === "console" || s.state !== "closed") return;
				const entry = vms.get(s.machine);
				if (!entry || (entry.phase !== "booting" && entry.phase !== "ready")) {
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
			case "screen/note":
				sessions.get(effect.session)?.screen.note(effect.text);
				return;
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
						const { text: output, truncated } = typed.output();
						const ms = Math.round(deps.now() - startedAt);
						resolve({ exitCode, output, truncated, lastLine: lastLineOf(output), ms });
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
					mark = s.screen.beginMark(source === "agent" ? "agent" : "bar", line);
					if (source === "agent") dispatch({ type: "session/marked", session, source: "agent" });
					send(s, vm, `${line}\r`);
				};

				signal.addEventListener("abort", aborted, { once: true });
				s.injection = injection;
				type();
			});
		},
	};

	const files: FilePort = {
		write(machine, file, signal) {
			return new Promise<FileOutcome>((resolve, reject) => {
				const entry = vms.get(machine);
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				if (entry?.phase !== "ready") {
					resolve({ kind: "refused", reason: `${machine} is not ready, so wait until it is.` });
					return;
				}
				const id = ++writes;
				const over = () => {
					signal.removeEventListener("abort", aborted);
					entry.writes.delete(id);
				};
				function aborted() {
					over();
					reject(signal.reason);
				}
				const { path } = file;
				entry.writes.set(id, {
					path,
					settle(outcome) {
						over();
						resolve(outcome);
					},
				});
				signal.addEventListener("abort", aborted, { once: true });
				entry.vm.writeFile(id, file);
			});
		},
	};

	return {
		run,
		exec,
		files,
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
			for (const job of jobs.values()) job.drop();
			for (const [machine, entry] of vms) {
				endWrites(entry, `${machine} stopped`);
				void entry.vm.stop("drop");
			}
			vms.clear();
			for (const s of sessions.values()) {
				abandon(s);
				screens.dispose(s.id);
			}
			sessions.clear();
		},
	};
}
