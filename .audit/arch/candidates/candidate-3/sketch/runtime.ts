// src/runtime/* — the imperative shell. It owns every Worker, the switch, the
// terminal screens and the capture log's write side. It does exactly two
// things: perform Effects, and report what happened as RuntimeEvents.
// It makes no lab decisions (names, ports, hues, lifecycle are model/).
//
// What happens to the prototype's classes:
//   Lab        retired. Allocation and lifecycle moved to model/ as pure functions; /etc/hosts sync is the hosts/publish effect.
//   Machine    reshaped into Vm: one Worker for one boot attempt, no state, no onChange, no mutable name.
//   Session    retired. Session metadata is model state; bytes go straight from Vm to Screens; scrollback lives in the VT core.
//   LabSwitch  kept, three edits: numbered ports, flushed-entry retention, toPorts as a bitmask.
//   frames/decode/nic/image/guest/protocol   kept as they are (frames+decode move to src/net/, pure).

import type { CaptureLog } from "./capture.ts";
import type { ExecPort, InjectOutcome } from "./commands.ts";
import type { BootConfig, Effect, MachineName, PortNo, RuntimeEvent, SessionId, Source } from "./model.ts";

// ───────────────────────────── LabSwitch deltas (runtime/switch.ts) ─────────────────────────────

/** Ports are keyed by number now. Port identity is the faceplate's identity. */
export interface SwitchPort {
	deliver(frame: Uint8Array): void;
}
export interface TapEvent {
	readonly seq: number;
	readonly t: number;
	readonly from: PortNo;
	readonly to: number; // bitmask
	readonly flooded: boolean;
	/** Unicast whose destination was not in the table (or only as a flushed entry). Drives "unknown destination, flooded". */
	readonly unknownDst: boolean;
	readonly frame: Uint8Array; // snapshot; the switch copies once per frame only while a tap exists
}
export interface MacEntry {
	readonly mac: string;
	readonly port: PortNo;
	readonly seenMs: number;
	/** Flushed by a link-down. Kept and shown struck through; never used for forwarding; relearning clears it; removePort deletes it. */
	readonly flushed: boolean;
}
export interface LabSwitchApi {
	attach(port: PortNo, p: SwitchPort): void;
	detach(port: PortNo): void; // deletes its MAC entries, flushed or not
	setLink(port: PortNo, up: boolean): void; // down: entries on the port become flushed (not deleted)
	receive(port: PortNo, frame: Uint8Array): void;
	onTap(fn: (e: TapEvent) => void): () => void;
	macTable(): readonly MacEntry[];
	counters(): { in: number; delivered: number; flooded: number }; // the footer's wording
}

// ───────────────────────────── Vm (runtime/vm.ts) ─────────────────────────────

/**
 * One boot attempt of one machine. Parses FromVm into these callbacks so the
 * wire protocol never leaves this file (per boundary-discipline).
 */
export interface VmCallbacks {
	stage(stage: string): void;
	ready(bootMs: number): void;
	failed(reason: string): void; // fatal error, worker error, image fetch failure, or guest exit: one sentence, verbatim
	frame(frame: Uint8Array): void;
	consoleBytes(bytes: Uint8Array): void;
	ptyReady(sid: number): void;
	ptyBytes(sid: number, bytes: Uint8Array): void;
	ptyExit(sid: number): void;
}
export interface Vm {
	write(sid: number | "console", data: string): void;
	resize(sid: number | "console", cols: number, rows: number): void;
	openPty(sid: number, cols: number, rows: number): void;
	closePty(sid: number): void;
	reconfigure(hosts: readonly { ip: string; name: string }[]): void; // no-op until ready
	deliver(frame: Uint8Array): void; // copies before transfer (a flood shares the frame)
	/** `stop`, then terminate after 250 ms (the kernel may be parked in Atomics.wait). Idempotent. */
	stop(): Promise<void>;
}
export function startVm(config: BootConfig, image: Promise<ArrayBufferLike>, cb: VmCallbacks): Vm {
	throw new Error("not implemented");
}

// ───────────────────────────── shell tracker (runtime/shell-tracker.ts, pure) ─────────────────────────────

/**
 * A byte-level scanner for OSC 133 (A prompt, B input, C running, D;code
 * finished) in a session's output, carrying partial sequences across chunk
 * boundaries. O(bytes), no allocation per chunk. The guest's prompt emits
 * these (guest.ts installs a PS1/ENV snippet at setup; see Open questions).
 * It is how exec learns exit codes, how a busy session is refused, and how a
 * line mark knows where to end — without depending on the renderer.
 */
export type ShellMark = { kind: "prompt" } | { kind: "running" } | { kind: "finished"; exitCode: number | null };
export interface ShellTracker {
	scan(bytes: Uint8Array): readonly ShellMark[]; // usually empty
	readonly phase: "prompt" | "running" | "unknown";
}
export function createShellTracker(): ShellTracker {
	throw new Error("not implemented");
}

// ───────────────────────────── screens (runtime/screens.ts) ─────────────────────────────

/**
 * One WTerm + GhosttyCore per session, created at session open, destroyed at
 * session end. Not per pane, not per mount: a parked pane, a background tab
 * and a removed-from-DOM pane keep parsing output (renderingPaused) and keep
 * their tracked positions, so marks and shell_read never depend on what is
 * on screen. A screen not attached to an <unlab-terminal> lives in the garage:
 * an off-screen, laid-out, `inert` container (WTerm needs layout to measure).
 *
 * The GhosttyCore WASM module is compiled once (GhosttyCore.load caches it).
 */
export interface Screen {
	readonly session: SessionId;
	write(bytes: Uint8Array): void;
	/** Move the screen's element into `host` (an <unlab-terminal>), unpause, fit. */
	attach(host: HTMLElement): void;
	/** Back to the garage, paused. */
	detach(): void;
	focus(): void;
	setFocusedStyle(focused: boolean): void; // solid block vs hollow cursor
	/** Start a gutter rule at the current cursor row. */
	beginMark(tone: "bar" | "agent"): LineMark;
	lastLines(n: number): string;
	dispose(): void;
}

/**
 * A gutter rule over a row range. Both ends are TrackedTerminalPosition from
 * the core, so they follow scrolling and reflow; they resolve to null when
 * the rows fall out of scrollback, and the rule is dropped then. Drawing: the
 * screen's element has one absolutely positioned overlay per *visible* mark,
 * recomputed on render (row → px from the renderer's row height and scroll
 * offset) — the stream itself is never touched.
 */
export interface LineMark {
	readonly tone: "bar" | "agent";
	/** Fix the end at the current cursor row and read the text between, minus the first (echoed) row. */
	end(): string;
}

export interface Screens {
	create(session: SessionId, sendInput: (data: string) => void, resize: (cols: number, rows: number) => void): Screen;
	get(session: SessionId): Screen | undefined;
	dispose(session: SessionId): void;
}
export function createScreens(garage: HTMLElement): Screens {
	throw new Error("not implemented");
}

// ───────────────────────────── the engine (runtime/engine.ts) ─────────────────────────────

/**
 * Maps the model's names to live objects:
 *   vms:      MachineName → { attempt, vm, port: PortNo | null }
 *   sessions: SessionId → { machine, sid: number | 'console', tracker: ShellTracker }
 *   ports:    PortNo → MachineName  (the switch's attach table, mirrored only as far as routing frames needs)
 * Every callback from a Vm is stamped with the attempt it was started for, so
 * a late message from a stopped worker becomes an event the reducer ignores.
 *
 * Byte path, per chunk (no store involvement):
 *   Vm.consoleBytes/ptyBytes → tracker.scan(bytes) → screen.write(bytes)
 *                            → for each ShellMark: resolve pending injects; dispatch session/shell only on phase *change*
 * Frame path, per frame:
 *   Vm.frame → switch.receive(port, frame) → tap → capture.appendFrame(...)  (O(1); notifies once per animation frame)
 */
export interface Engine extends ExecPort {
	run(effect: Effect): void;
	/** Reads for elements that show runtime-owned data (MAC table, counters). Polled on tick while visible. */
	readonly reads: RuntimeReads;
}
export interface RuntimeReads {
	macTable(): readonly MacEntry[];
	counters(): { in: number; delivered: number; flooded: number };
}

export interface EngineDeps {
	readonly dispatch: (e: RuntimeEvent) => void;
	readonly capture: CaptureLog;
	readonly screens: Screens;
	readonly sw: LabSwitchApi;
	readonly image: (name: string) => Promise<ArrayBufferLike>;
	readonly startVm: typeof startVm; // injectable: tests use a fake Vm that scripts boot/fail/exit
	readonly announce: (text: string) => void;
	readonly setClock: (hz: 1 | 10) => void;
}

export function createEngine(deps: EngineDeps): Engine {
	throw new Error("not implemented");
	// run(e): switch (e.type)
	//   'vm/boot'      → startVm(e.config, image(spec.image), callbacks stamped with e.attempt)
	//   'vm/stop'      → vms.get(m)?.vm.stop().then(() => dispatch vm/stopped{m, attempt})   (idempotent: unknown → dispatch anyway)
	//   'port/attach'  → sw.attach(port, { deliver: f => vms.get(m)?.vm.deliver(f) })
	//   'port/detach'  → sw.detach(port)
	//   'link/set'     → sw.setLink(port, up); capture.appendLink({ port, machine, up, cause, t })
	//   'pty/open'     → vm.openPty(sid, cols, rows)  (sid allocated here; SessionId ↔ sid kept in `sessions`)
	//   'screen/*'     → screens.create/dispose/get().focus()
	//   'hosts/publish'→ remember; push to every ready vm; a vm that becomes ready later gets it in its ready callback
	//   'capture/clear'→ capture.clear()
	//   'announce'     → announce(text)    'clock' → setClock(hz)
}

/**
 * inject(session, line, source, signal):
 *   1. tracker.phase === 'running' → reject("node2:console is running a program. Use node2:sh1 or sh node2.")
 *   2. mark = screen.beginMark(source === 'agent' ? 'agent' : 'bar'); dispatch session/marked when agent
 *   3. vm.write(sid, line + '\r')
 *   4. await the tracker's next `finished` mark for this session (FIFO of pending injects), or signal abort
 *   5. output = mark.end(); resolve { exitCode, output, ms }
 * A guest without OSC 133 never emits `finished`: the mark ends at the next `prompt` heuristic or after
 * EXEC_CAP_MS (30 s) with exitCode null — shown as `exit ?`. See Open questions: exit codes.
 */
export declare function inject(session: SessionId, line: string, source: Source, signal: AbortSignal): Promise<InjectOutcome>;
export declare const EXEC_CAP_MS: 30_000;

/** For readers: the Vm and switch exist only behind Engine; nothing outside runtime/ imports vm.ts or switch.ts. */
export type _VmIsPrivate = MachineName;
