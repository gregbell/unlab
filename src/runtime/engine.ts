// The effect executor. It performs what the model asks (boot, stop, plug, cut,
// open, publish) on live workers, the switch and the screens, and reports what
// happened as runtime events. It decides nothing: names, ports, lifecycle and
// timeouts are the model's.
//
// Bytes and frames never reach the store. Per chunk: vm → screen (which scans
// it for the shell's marks) → at most a phase event. Per frame: vm → fabric →
// the neighbours' vms, and the tap → capture log.
//
// The engine may dispatch from inside run(), so the store must queue an event
// dispatched while it is still running the effects of the previous one.

import type { CaptureLog } from "../capture/index.ts";
import type { ExecOutcome, ExecPort, FileOutcome, FilePort } from "../commands/index.ts";
import {
	type CableCounters,
	type DiskCopy,
	type Effect,
	type HostEntry,
	type MachineName,
	type NicNo,
	type NicRef,
	type PortNo,
	type PortRef,
	parseSessionId,
	type RuntimeEvent,
	type SessionId,
	type StopHow,
	type SwitchName,
} from "../model/index.ts";
import type { Clock } from "./clock.ts";
import type { Fabric, FabricEvents, MacEntry, PortCounters, SwitchCounters } from "./fabric.ts";
import type { LinkTarget } from "./machine-link.ts";
import type { CopyJob, CopyReport } from "./protocol.ts";
import { createPump } from "./pump.ts";
import type { LineMark, Screen, Screens } from "./screens.ts";
import type { ShellEvent } from "./shell-tracker.ts";
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
	macTable(of: SwitchName): readonly MacEntry[];
	counters(port: PortRef): PortCounters | undefined;
	/** What the cable in the port has carried and dropped, both ways. */
	carried(port: PortRef): CableCounters | undefined;
	/** The whole switch's. */
	totals(of: SwitchName): SwitchCounters;
}

export interface Engine {
	run(effect: Effect): void;
	readonly exec: ExecPort;
	readonly files: FilePort;
	readonly screens: Screens;
	readonly capture: CaptureLog;
	readonly reads: RuntimeReads;
	/** Link every machine with a CLI, those that boot later too, or unlink them. */
	link(target: LinkTarget | null): void;
	/** Stop every machine and the clock. Reports nothing. */
	dispose(): void;
}

export interface EngineDeps {
	readonly store: RuntimeStore;
	/** ms since the lab started: the capture log's clock and the model's. Its timers carry frames between switches. */
	readonly clock: Clock;
	/** Every switch of the lab and the cables between them, made once. */
	readonly newFabric: (events: FabricEvents) => Fabric;
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

/** One port of a switch that there is. */
interface Socket {
	readonly slot: number;
	readonly port: PortNo;
}

interface SwitchEntry {
	/** Where it is in the fabric. */
	readonly slot: number;
	/** Whose cable is in each port that a NIC's is in. */
	readonly cables: Map<PortNo, NicRef>;
}

const NOTHING_CARRIED: SwitchCounters = { in: 0, delivered: 0, flooded: 0, dropped: 0 };

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
	const { capture, screens } = deps;
	const now = () => deps.clock.now();
	const dispatch = (event: RuntimeEvent) => deps.store.dispatchRuntime(event);

	const vms = new Map<MachineName, VmEntry>();
	const sessions = new Map<SessionId, SessionEntry>();
	const jobs = new Map<MachineName, Job>();
	const switches = new Map<SwitchName, SwitchEntry>();
	/** Where each plugged NIC's frames go in. The same cables as the switches', found by NIC. */
	const plugged = new Map<MachineName, Map<NicNo, Socket>>();
	let published: readonly HostEntry[] | null = null;
	let writes = 0;
	let clock: { readonly hz: 1 | 10; readonly stop: () => void } | null = null;

	/** The name of the switch in each slot of the fabric. */
	const slots: (SwitchName | undefined)[] = [];
	const fabric = deps.newFabric({
		tap(slot, e) {
			const name = slots[slot];
			if (name) capture.appendFrame({ switch: name, ...e });
		},
		storm(slot, { since, rate, looped, dropped }, over) {
			const name = slots[slot];
			if (!name) return;
			capture.appendStorm({ switch: name, over, looped, dropped, ms: now() - since });
			dispatch({ type: "switch/storm", switch: name, storm: over ? null : { since, rate, dropped } });
		},
	});
	const pump = createPump(fabric, deps.clock);

	/** Made the first time a port of it is named. */
	const switchOf = (name: SwitchName): SwitchEntry => {
		const known = switches.get(name);
		if (known) return known;
		const entry: SwitchEntry = { slot: fabric.addSwitch(), cables: new Map() };
		slots[entry.slot] = name;
		switches.set(name, entry);
		return entry;
	};

	/** Whatever is in the port comes out. A cable to another switch comes out of that one too. */
	const unplug = ({ switch: on, port }: PortRef): void => {
		const entry = switches.get(on);
		if (!entry) return;
		fabric.detach(entry.slot, port);
		const held = entry.cables.get(port);
		if (!held) return;
		entry.cables.delete(port);
		const nics = plugged.get(held.machine);
		const at = nics?.get(held.nic);
		if (at?.slot === entry.slot && at.port === port) nics?.delete(held.nic);
	};

	const dropSwitch = (name: SwitchName): void => {
		const entry = switches.get(name);
		if (!entry) return;
		for (const port of entry.cables.keys()) unplug({ switch: name, port });
		fabric.removeSwitch(entry.slot, now());
		slots[entry.slot] = undefined;
		switches.delete(name);
	};

	/** Whether the cable that goes from the first port to the second is in. */
	const cabled = ([a, b]: readonly [PortRef, PortRef]): boolean => {
		const from = switches.get(a.switch);
		const far = from && fabric.farEnd(from.slot, a.port);
		return far !== null && far !== undefined && far.slot === switches.get(b.switch)?.slot && far.port === b.port;
	};

	/** While a switch storms, the model has its numbers once a tick. */
	const readStorms = () => {
		for (const [name, { slot }] of switches) {
			const reading = fabric.storm(slot, now());
			if (!reading) continue;
			const { since, rate, dropped } = reading;
			dispatch({ type: "switch/storm", switch: name, storm: { since, rate, dropped } });
		}
	};

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
			const at = plugged.get(ref.machine)?.get(nic);
			if (at) pump.receive(at.slot, at.port, frame);
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
				dispatch({ type: "checkpoint/restored", machine, attempt, set, at: now() });
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

	let linkTarget: LinkTarget | null = null;

	const tick = () => {
		const at = now();
		capture.sweep(at);
		settleQuiet(at);
		readStorms();
		dispatch({ type: "tick", now: at });
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
				if (linkTarget) vm.link(linkTarget);
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
					dispatch({ type: "vm/stopped", machine, attempt, clean: true, at: now() });
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
					dispatch({ type: "vm/stopped", machine, attempt, clean, at: now() });
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
				const { machine, nic } = effect;
				const { port } = effect.port;
				const { slot, cables } = switchOf(effect.port.switch);
				const held = cables.get(port);
				if (held?.machine === machine && held.nic === nic) return;
				unplug(effect.port);
				cables.set(port, { machine, nic });
				const nics = plugged.get(machine) ?? new Map<NicNo, Socket>();
				plugged.set(machine, nics.set(nic, { slot, port }));
				fabric.attach(slot, port, {
					deliver(frame) {
						const entry = vms.get(machine);
						if (entry && entry.phase !== "dropped") entry.vm.deliver(nic, frame);
					},
				});
				// Reserved, not live: the model raises the link when the machine is ready.
				fabric.setLink(slot, port, false);
				return;
			}
			case "cable/attach": {
				if (cabled(effect.ends)) return;
				const [a, b] = effect.ends;
				unplug(a);
				unplug(b);
				const from = { slot: switchOf(a.switch).slot, port: a.port };
				fabric.cable(from, { slot: switchOf(b.switch).slot, port: b.port });
				// As a NIC's: the link is the model's to raise.
				fabric.setLink(from.slot, from.port, false);
				return;
			}
			case "cable/detach":
				if (cabled(effect.ends)) unplug(effect.ends[0]);
				return;
			case "cable/link": {
				const { ends, up, cause, plug, cut } = effect;
				if (cabled(ends) && !cut) fabric.setLink(switchOf(ends[0].switch).slot, ends[0].port, up);
				capture.appendCable({ ends, up, cause, plug, cut });
				return;
			}
			case "port/detach":
				unplug(effect.port);
				return;
			case "switch/remove":
				// One that comes back under its name is another switch.
				dropSwitch(effect.switch);
				return;
			case "link/set": {
				const { port, machine, nic, up, cause, plug } = effect;
				fabric.setLink(switchOf(port.switch).slot, port.port, up);
				capture.appendLink({ port, machine, nic, up, cause, plug });
				return;
			}
			case "capture/dead-cable": {
				const { port, machine, nic, cause, dead } = effect;
				capture.appendLink({ port, machine, nic, up: false, cause, dead });
				return;
			}
			case "port/vlan":
				fabric.setVlan(switchOf(effect.port.switch).slot, effect.port.port, effect.vlan);
				return;
			case "port/conditions":
				fabric.setConditions(switchOf(effect.port.switch).slot, effect.port.port, effect.conditions);
				return;
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

				const startedAt = now();
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
						const ms = Math.round(now() - startedAt);
						resolve({ exitCode, output, truncated, lastLine: lastLineOf(output), ms });
					},
					fail(reason) {
						over();
						reject(reason);
					},
				};
				function aborted() {
					const vm = s && readyVm(s.machine);
					// Ctrl-C in the person's terminal is Ctrl-C in the machine's. An agent that gives up leaves what it started.
					if (s && vm && mark && source === "cli") send(s, vm, "\x03");
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
			macTable(of) {
				const entry = switches.get(of);
				return entry ? fabric.macTable(entry.slot, now()) : [];
			},
			counters({ switch: of, port }) {
				const entry = switches.get(of);
				return entry && fabric.counters(entry.slot, port);
			},
			carried({ switch: of, port }) {
				const entry = switches.get(of);
				return entry && fabric.carried(entry.slot, port);
			},
			totals(of) {
				const entry = switches.get(of);
				return entry ? fabric.totals(entry.slot) : NOTHING_CARRIED;
			},
		},
		link(target) {
			linkTarget = target;
			for (const { vm } of vms.values()) vm.link(target);
		},
		dispose() {
			clock?.stop();
			clock = null;
			pump.stop();
			for (const name of switches.keys()) dropSwitch(name);
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
