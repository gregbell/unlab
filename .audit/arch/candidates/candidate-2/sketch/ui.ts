// src/ui/* — custom elements in light DOM, templated with lit-html, all
// reading one store. Elements are subscription boundaries; rows, ports and
// the confirm block are pure template functions in ui/parts/.

import type { TemplateResult } from 'lit-html';
import type { AnyCommand, Env, LineError, Result, Suggestion } from './commands.ts';
import type { LabState, MachineName, SessionId } from './domain.ts';
import type { LineMark, SessionLog } from './store.ts';

// ───────────────────────── base element ─────────────────────────

/**
 * ~60 lines. Each element declares what it reads as one selector; render()
 * is a pure function of that slice (plus element-local UI state). The base
 * subscribes on connect, unsubscribes on disconnect, and renders with
 * lit-html's render(template, this) — light DOM, so ARIA idrefs
 * (aria-activedescendant, aria-controls, tab↔tabpanel) resolve across
 * elements and wterm's global stylesheet applies.
 *
 * The app's Env reaches elements through one module-level `provide(env)`
 * called by main.ts before customElements.define — no context protocol,
 * no prop drilling. Tests call provide(fakeEnv).
 */
export abstract class View<Slice> extends HTMLElement {
  protected abstract select(s: LabState): Slice;
  protected abstract render(slice: Slice): TemplateResult;
  /** Override for slices that are fresh objects; default Object.is. */
  protected equals(a: Slice, b: Slice): boolean { return Object.is(a, b); }
  protected get env(): Env { throw new Error('not implemented'); }
  /** Re-render with the current slice (after element-local state changes). */
  protected update(): void { throw new Error('not implemented'); }
  connectedCallback(): void { throw new Error('not implemented'); }
  disconnectedCallback(): void { throw new Error('not implemented'); }
}

export function provide(env: Env): void { throw new Error('not implemented'); }

/** Selectors live beside their elements but are exported for unit tests. */
export interface RailRow { name: MachineName; hue: number; state: string; word: string; second: string; focused: boolean; parked: boolean; disabled: boolean }
export function selectRail(s: LabState): readonly RailRow[] { throw new Error('not implemented'); }
export function selectStatus(s: LabState): { left: { text: string; tone: 'ok' | 'down' | 'warn' }[]; right: { text: string; tone: 'ok' | 'down' | 'warn' }[] } {
  throw new Error('not implemented');
}

// ───────────────────────── terminal ─────────────────────────

/**
 * <unlab-terminal session="node2:sh1">. Owns one WTerm + GhosttyCore for as
 * long as it is connected. Elements are never moved in the DOM (a move is a
 * disconnect + connect, which would rebuild the terminal): <unlab-pane-area>
 * renders every pane in creation order and places it with grid-row/column
 * from tile(); parked and inactive-tab terminals stay mounted, `hidden`,
 * renderingPaused. A terminal is destroyed only when its session closes or
 * its machine is removed. The log replay on mount covers the bytes that
 * arrived before the element connected.
 *
 * Feeding bytes is where marks get rows:
 *   on mount: for each retained chunk, split at mark offsets; after writing
 *   up to a mark boundary, anchor = bridge.trackPosition(cursor)
 *   live:     same, per chunk, via log.onData / log.onMark
 * The gutter is an absolutely positioned layer inside the scroll container;
 * each rule's top/height = resolve(from/to).row × row height (20px). Rows
 * resolve null after scrollback prunes them; the rule is then dropped.
 */
export class TerminalElement extends HTMLElement {
  static readonly observedAttributes = ['session', 'cursor'] as const;
  /** Replays the log, subscribes to new bytes and marks, wires onData → runtime.write. */
  mount(log: SessionLog): Promise<void> { throw new Error('not implemented'); }
  /** The spec's mark(fromRow, toRow, source), driven by LineMarks rather than called by commands. */
  protected placeMark(mark: LineMark): void { throw new Error('not implemented'); }
  setActive(active: boolean, focused: boolean): void { throw new Error('not implemented'); }
  focusTerminal(): void { throw new Error('not implemented'); }
}

/** WTerm options shared by every terminal; `webmcp: false` (our own tools only). */
export declare const TERMINAL_THEME: Record<string, string>;

// ───────────────────────── command bar model (pure) ─────────────────────────

/**
 * The bar's editing state is element-local (it is not lab state), but its
 * transitions are a pure reducer so every state in HANDOFF frames 1–5 is a
 * unit test: resting, empty, completing, preview, error, confirm, result.
 */
export type BarMode =
  | { kind: 'closed' }
  | { kind: 'editing'; preview: { will: string; assumed: string | null } | null }
  | { kind: 'error'; error: LineError; echo: string }
  | { kind: 'confirm'; question: string; actionLabel: string; command: AnyCommand; args: unknown }
  | { kind: 'running' }
  | { kind: 'result'; result: Result };

export interface BarState {
  readonly mode: BarMode;
  readonly text: string;
  readonly cursor: number;
  readonly suggestions: readonly Suggestion[];
  readonly chosen: number;
  /** Index into bar-typed history while walking with Up; null when not walking. */
  readonly historyAt: number | null;
  /** Shown on the right of the input: `tab → alpine`, `↵ run`, `↵ again to remove`. */
  readonly hint: string;
}

export type BarAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'input'; text: string; cursor: number }
  | { type: 'tab' }
  | { type: 'arrow'; dir: -1 | 1 }
  | { type: 'enter'; keepOpen: boolean }
  | { type: 'escape' }
  | { type: 'digit'; n: number }
  | { type: 'finished'; result: Result | LineError };

/** What the element must do after a transition: nothing, run a command, or focus a machine. */
export type BarEffect = null | { run: AnyCommand; args: unknown } | { focus: MachineName };

export function barReduce(b: BarState, a: BarAction, s: LabState): { bar: BarState; effect: BarEffect } { throw new Error('not implemented'); }

// ───────────────────────── announcer ─────────────────────────

/** Pure diff → sentences for the one polite live region: 'node4 ready', 'Cable to node3 cut', 'node3 · waiting for you'. */
export function announcements(prev: LabState, next: LabState): string[] { throw new Error('not implemented'); }

export type { SessionId };
