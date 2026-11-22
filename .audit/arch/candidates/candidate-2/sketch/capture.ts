// src/store/capture.ts — the capture lane: ring buffer + incremental filter.
// Owned by the store; written by the switch tap and the reconciler only.

import type { MachineName, PortNo } from './domain.ts';
import type { CaptureRow, FrameRow } from './store.ts';

/**
 * Filter grammar: terms separated by spaces are AND; the word `or` splits
 * OR-groups (no parentheses). A term is a protocol (arp icmp tcp udp …), a
 * machine name (either end), an IPv4, a MAC, or port:N. Case-insensitive.
 * Compiling is the validation: a bad term returns where it is, the field
 * turns --down, and the old filter stays in force.
 */
export type FilterTerm =
  | { kind: 'proto'; proto: string }
  | { kind: 'machine'; name: MachineName }
  | { kind: 'ip'; ip: string }
  | { kind: 'mac'; mac: string }
  | { kind: 'port'; port: PortNo };

export interface CompiledFilter {
  readonly source: string;
  /** OR of ANDs. Empty = match everything. Link rows match only the empty filter or a port: term. */
  readonly groups: readonly (readonly FilterTerm[])[];
  test(row: CaptureRow): boolean;
}

export function compileFilter(text: string, machines: readonly MachineName[]): CompiledFilter | { bad: string; at: number } {
  throw new Error('not implemented');
}

/**
 * Fixed-capacity ring of rows. `matches` is a parallel ring of seq numbers
 * that passed the current filter:
 *   push(row): ring.push; if filter.test(row) matches.push(row.seq)   — O(terms)
 *   eviction : drop matches whose seq < ring.firstSeq                 — amortised O(1)
 *   setFilter: rebuild matches with one pass                          — O(buffer), once per edit
 *   matches.at(i): ring.at(seq - ring.firstSeq)                       — O(1)
 * Nothing per frame touches more than one row. The dock reads tail(8); Wire
 * renders only the rows in its scroll window (fixed 26px rows → index math).
 */
export class CaptureRing {
  constructor(capacity: number) { throw new Error('not implemented'); }
  push(row: CaptureRow): void { throw new Error('not implemented'); }
  setFilter(f: CompiledFilter): void { throw new Error('not implemented'); }
  clear(): void { throw new Error('not implemented'); }
  get length(): number { throw new Error('not implemented'); }
  at(i: number): CaptureRow { throw new Error('not implemented'); }
  bySeq(seq: number): CaptureRow | null { throw new Error('not implemented'); }
}

/**
 * ARP requests waiting for a reply, keyed `${spa}>${tpa}`. A reply removes
 * the key; sweep(now) gives every request older than 1 s the `no reply` note
 * (FrameRow.note is the one field set after append; only this module sets it)
 * and bumps the capture revision so visible rows repaint.
 */
export class ArpWatch {
  request(row: FrameRow): void { throw new Error('not implemented'); }
  reply(row: FrameRow): void { throw new Error('not implemented'); }
  sweep(now: number, note: (seq: number, text: string) => void): boolean { throw new Error('not implemented'); }
  get pending(): number { throw new Error('not implemented'); }
}

/** pcap (LINKTYPE_ETHERNET) of every frame row in the ring, ignoring the filter. */
export function toPcap(rows: Iterable<CaptureRow>, labStartEpochMs: number): Blob { throw new Error('not implemented'); }
