// src/store/* — one store: the reduced control state plus append-only lanes.
//
// Two lanes, one rule: anything that arrives at wire speed (frames, terminal
// bytes) is appended to a lane in O(1) and marks the store dirty; it never
// runs the reducer. Subscribers are notified once per animation frame with
// the current state, and read lanes by index. Writers and readers get
// different interfaces, so a component cannot append a frame and the runtime
// cannot read a filtered view it has no business with.

import type { LabEvent, LabState, MachineName, PortNo, SessionId, Source } from './domain.ts';

// ───────────────────────── store core ─────────────────────────

export type Selector<T> = (s: LabState) => T;
export type Equals<T> = (a: T, b: T) => boolean;

export interface Store {
  readonly state: LabState;
  /** Runs reduce synchronously; subscribers hear about it at the next flush. */
  dispatch(e: LabEvent): void;
  /**
   * Subscribe to a slice. `fn` runs at flush time only when `equals(prev, next)`
   * is false (default: Object.is, which is right because reduce shares structure).
   * Returns an unsubscribe. Cost per flush: O(subscribers), never O(buffer).
   */
  select<T>(sel: Selector<T>, fn: (value: T, state: LabState) => void, equals?: Equals<T>): () => void;
  /** Resolve when `pred(state)` holds (checked at each flush); reject on abort. Commands await effects with this. */
  until(pred: (s: LabState) => boolean, signal: AbortSignal): Promise<LabState>;
  readonly lanes: LaneReaders;
}

export interface StoreOptions {
  initial: LabState;
  /** Injected for tests: run flush synchronously instead of on rAF. */
  schedule?: (flush: () => void) => void;
  captureCapacity?: number; // default 10_000 frames; open question
}

/** Returns the store plus the writer half of the lanes, which only main.ts hands to the runtime. */
export function createStore(opts: StoreOptions): { store: Store; writers: LaneWriters } {
  // TODO: dispatch → state = reduce(state, e); scheduleFlush()
  // TODO: lane appends → laneDirty |= bit; scheduleFlush()
  // TODO: flush → if laneDirty, state = reduce(state, {type:'lanes', ...revs});
  //        then for each subscription compare and call. One flush per frame.
  throw new Error('not implemented');
}

// ───────────────────────── capture lane ─────────────────────────

/** Decoded once, at append. `info` is lazy: built on first read (visible rows only). */
export interface FrameRow {
  readonly kind: 'frame';
  readonly seq: number;
  /** Seconds since lab start, for the time column and pcap. */
  readonly t: number;
  readonly len: number;
  readonly ingress: PortNo;
  readonly egress: readonly PortNo[];
  readonly proto: string;
  readonly srcMac: string;
  readonly dstMac: string;
  readonly srcIp: string | null;
  readonly dstIp: string | null;
  /** Lab names resolved at append time, so a later removal does not rename history. */
  readonly from: MachineName | null;
  /** null = broadcast ('everyone'); string = raw unknown address. */
  readonly to: MachineName | string | null;
  readonly bytes: Uint8Array;
  info(): string;
  /** Annotation in --warn after the middle dot; `no reply` may arrive up to ~1 s later. */
  readonly note: string | null;
}

export interface LinkRow {
  readonly kind: 'link';
  readonly seq: number;
  readonly t: number;
  readonly port: PortNo;
  readonly up: boolean;
  /** `Cable to node3 cut by the agent.` */
  readonly text: string;
}

export type CaptureRow = FrameRow | LinkRow;

export interface CaptureReader {
  /** Ring contents, oldest first. O(1) random access. */
  readonly length: number;
  at(i: number): CaptureRow;
  /** Rows matching the current filter, maintained incrementally (see capture.ts). */
  readonly matches: { readonly length: number; at(i: number): CaptureRow };
  readonly counters: { readonly in: number; readonly delivered: number; readonly flooded: number };
  /** Last n matching rows; the dock calls tail(8). */
  tail(n: number): CaptureRow[];
  /** The whole buffer, ignoring the filter (Save .pcap). */
  pcap(): Blob;
}

export interface CaptureWriter {
  /** Called by the switch tap: O(1) amortised, including filter matching. */
  frame(tap: import('./runtime.ts').TapEvent, names: NameIndex): void;
  /** Called by the reconciler when it applies a cable change to the switch. */
  link(port: PortNo, up: boolean, text: string): void;
  /** Ages pending ARP requests; sets `no reply` on those older than 1 s. Called on tick. */
  sweep(now: number): void;
  setFilter(filter: import('./capture.ts').CompiledFilter): void;
  setPaused(paused: boolean): void;
  clear(): void;
}

/** MAC/IP/port → machine, rebuilt on spawn/remove only (≤ 8 entries). */
export interface NameIndex {
  byMac(mac: string): MachineName | null;
  byIp(ip: string): MachineName | null;
  byPortId(id: string): { name: MachineName; port: PortNo } | null;
}

// ───────────────────────── session lane ─────────────────────────

/**
 * One per session, created when the session opens and dropped when it
 * closes. Bytes are addressed by absolute offset since the session began;
 * the ring keeps the last 256 KiB (as the prototype does). Marks are
 * anchored in this byte stream, not in terminal rows: the terminal element
 * converts offsets to rows as it feeds bytes, so marks survive remounts
 * (parking, tab switches) and reflow without the store knowing about rows.
 */
export interface SessionLog {
  readonly id: SessionId;
  /** Absolute offset of the first retained byte, and one past the last. */
  readonly start: number;
  readonly end: number;
  /** Retained chunks with their absolute start offsets, oldest first. */
  chunks(): Iterable<{ readonly at: number; readonly bytes: Uint8Array }>;
  readonly marks: readonly LineMark[];
  /** Live output after `from`. Returns an unsubscribe. Called per chunk, synchronously. */
  onData(fn: (bytes: Uint8Array, at: number) => void): () => void;
  onMark(fn: (mark: LineMark) => void): () => void;
}

export interface LineMark {
  readonly id: number;
  readonly source: Exclude<Source, 'button'> | 'button';
  readonly from: number;
  /** null while the command is still running: the rule grows with output. */
  readonly to: number | null;
}

export interface LaneReaders {
  readonly capture: CaptureReader;
  session(id: SessionId): SessionLog | null;
  /** Switch-owned facts, snapshotted at flush when the switch version moved. */
  readonly switch: SwitchReader;
}

export interface LaneWriters {
  readonly capture: CaptureWriter;
  /** Driver appends guest output; returns the new end offset. */
  append(id: SessionId, bytes: Uint8Array): number;
  open(id: SessionId): void;
  close(id: SessionId): void;
  beginMark(id: SessionId, source: LineMark['source']): number;
  endMark(id: SessionId, mark: number): void;
}

// ───────────────────────── switch reader ─────────────────────────

export interface MacRow {
  readonly mac: string;
  readonly port: PortNo;
  readonly machine: MachineName | null;
  readonly seenMsAgo: number;
  /** Kept, struck through, until relearned or the machine is removed. */
  readonly flushed: boolean;
}

export interface SwitchReader {
  macTable(): readonly MacRow[];
  counters(port: PortNo): { rx: number; tx: number; dropped: number; flooded: number } | null;
}
