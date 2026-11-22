// src/runtime/* — the kernels, the wire and the reconciler that makes them
// match LabState. The prototype's src/lab/{frames,decode,nic,image,guest,
// protocol}.ts and src/vm-worker.ts move here unchanged. switch.ts gets three
// small changes. machine.ts and lab.ts are replaced: identity, lifecycle and
// naming moved into domain/; what is left of Machine is a Driver.

import type { LabState, Machine, MachineName, PortNo, SessionId, Source } from './domain.ts';
import type { LaneWriters, NameIndex, Store } from './store.ts';

// ───────────────────────── switch.ts (kept; three changes) ─────────────────────────

export interface TapEvent {
  seq: number;
  t: number;
  fromPort: string;
  fromName: string;
  toPorts: string[];
  flooded: boolean;
  /** NEW: true when a unicast destination had no live entry (unknown or flushed). */
  unknownUnicast: boolean;
  frame: Uint8Array;
}

/**
 * Changes to LabSwitch, and only these:
 *  1. setLink(id, false) marks entries learned on that port `flushed` instead
 *     of deleting them; forwarding ignores flushed entries; learning the MAC
 *     again (any port) clears the flag; removePort deletes them.
 *  2. macTable() returns `flushed` per entry; `version` bumps on any table change.
 *  3. TapEvent gains `unknownUnicast` so annotation needs no second lookup.
 * Port *numbers* are not the switch's business: ports stay string ids (the
 * machine name), and domain/ owns the 1..8 numbering.
 */
export interface LabSwitchChanges {
  readonly version: number;
  macTable(): Array<{ mac: string; port: string; name: string; ageMs: number; flushed: boolean }>;
}

// ───────────────────────── runtime: what the rest of the app may ask of kernels ─────────────────────────

export interface ExecOutcome {
  readonly exitCode: number | null;
  /** ANSI-stripped output between the echoed line and the prompt. */
  readonly output: string;
  readonly ms: number;
}

/**
 * The imperative surface. Lifecycle is NOT here: nobody calls boot() or
 * stop(). The reconciler derives those from state. What is here is what has
 * no state of its own: bytes in, bytes out, and a command whose result is a
 * value rather than a state change.
 */
export interface Runtime {
  /** Terminal keystrokes. Hot path; not a command. */
  write(session: SessionId, data: string): void;
  resize(session: SessionId, cols: number, rows: number): void;
  /**
   * Type `line` into the session, mark it with `source`, and resolve when
   * the shell returns to its prompt. Calls on one session are queued, never
   * interleaved. Aborting sends ^C and resolves with exitCode null.
   * Mechanism (step 7 spike): OSC 133 prompt marks installed by guest setup,
   * parsed from the session byte stream by `PromptTracker`; sentinel fallback.
   */
  execInSession(session: SessionId, line: string, source: Source, signal: AbortSignal): Promise<ExecOutcome>;
}

/** Streaming OSC 133 scanner over a session's bytes. Pure; fed by the driver. */
export interface PromptTracker {
  feed(bytes: Uint8Array, at: number): Array<{ kind: 'prompt' | 'command-start' | 'command-end'; at: number; exitCode: number | null }>;
}

// ───────────────────────── driver: one worker for one boot attempt ─────────────────────────

/**
 * What remains of the prototype's Machine: owns one Worker and one switch
 * port for exactly one boot attempt, translates FromVm into RuntimeEvents
 * tagged with that attempt, and appends console/pty bytes to the session
 * lane. No public mutable fields, no onChange. Boot again = new Driver.
 */
export interface Driver {
  readonly machine: MachineName;
  readonly attempt: number;
  setLink(up: boolean): void;
  openShell(id: SessionId, cols: number, rows: number): void;
  closeShell(id: SessionId): void;
  pushHosts(hosts: readonly { ip: string; name: string }[]): void;
  readonly hostsVersion: number;
  /** stop, then terminate after 250 ms; resolves when the worker is gone. Idempotent. */
  dispose(): Promise<void>;
}

export interface DriverDeps {
  dispatch: Store['dispatch'];
  lanes: LaneWriters;
  /** src/runtime/switch.ts LabSwitch (the prototype's, with LabSwitchChanges). */
  sw: LabSwitchChanges & { addPort(id: string, o: { name: string; deliver(f: Uint8Array): void }): void; removePort(id: string): void; setLink(id: string, up: boolean): void; receive(id: string, f: Uint8Array): void };
  image(name: string): Promise<ArrayBufferLike>;
  /** new Worker(new URL('./vm-worker.ts', import.meta.url), …) stays literal inside this factory. */
  spawnWorker(name: MachineName): Worker;
}

export function startDriver(m: Machine, deps: DriverDeps): Driver { throw new Error('not implemented'); }

// ───────────────────────── reconciler ─────────────────────────

/**
 * Subscribes to the store and, on every flush, makes the world match state.
 * Every rule is "if desired != actual, act", so it is idempotent: running it
 * twice does nothing the second time, and a crash halfway is repaired at the
 * next flush.
 *
 *   booting, no driver for (name, attempt)  → dispose stale driver; startDriver
 *   failed with a driver                    → dispose it (frees the port on the switch)
 *   removing                                → setLink(false) first (neighbours see it leave),
 *                                             capture.link(port, false, …), dispose,
 *                                             then dispatch rt-gone
 *   ready, net.cable != switch link         → driver.setLink; capture.link(port, up, text by cableBy)
 *   ready, hostsVersion < hostsHash(state)  → driver.pushHosts   (replaces Lab#sync)
 *   session in state but not in driver      → openShell; in driver but not state → closeShell
 *   machine set changed                     → rebuild NameIndex
 *
 * Also owns the 100 ms `tick` while anything is booting or an ARP is pending,
 * and calls capture.sweep(now) on each tick.
 */
export function startReconciler(store: Store, deps: Omit<DriverDeps, 'dispatch'>): { names: NameIndex; runtime: Runtime; stop(): void } {
  throw new Error('not implemented');
}

/** Pure: the host table every ready guest should have. */
export function hostsFor(s: LabState): { version: string; hosts: { ip: string; name: string }[] } { throw new Error('not implemented'); }

/** Pure: annotation for one tap, given the port numbering. */
export function annotate(tap: TapEvent, portOf: (id: string) => PortNo | null): string | null {
  // TODO: unknownUnicast        → `unknown destination, flooded to port 2` (ports listed)
  //       group dst             → null (broadcast is normal; route says `everyone`)
  //       delivered nowhere     → `dropped, port N is cut`
  //       ARP request           → null now; capture lane records it as pending for sweep()
  throw new Error('not implemented');
}
