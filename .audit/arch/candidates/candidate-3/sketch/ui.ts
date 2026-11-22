// src/ui/* — Lit custom elements, light DOM, reading the store through one
// controller and acting through three doors: a command's run, app.ui(UiEvent),
// and screens. They cannot dispatch anything else (Store is not on AppServices).

import { LitElement, html, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";
import { createContext, ContextConsumer } from "@lit/context";
import type { CaptureView } from "./capture.ts";
import type { Registry, Command, Result, LineError, Preview, ConfirmText, Suggestion, Approval } from "./commands.ts";
import type { LabState, MachineName, ReadStore, SessionId, UiEvent, HueNo } from "./model.ts";
import { selectRail, selectStatus } from "./model.ts";
import type { RuntimeReads, Screen } from "./runtime.ts";

// ───────────────────────────── services (src/services.ts; types only) ─────────────────────────────

export interface AppServices {
	readonly store: ReadStore;
	readonly commands: Registry;
	readonly ui: (e: UiEvent) => void;
	readonly capture: CaptureView;
	readonly reads: RuntimeReads;
	readonly screens: { get(session: SessionId): Screen | undefined };
	readonly agent: AgentControls;
	/** Opens the bar with a line, already in its confirm state — how a danger *button* gets its confirmation. */
	readonly confirmInBar: (line: string, source: "button") => void;
}
export interface AgentControls {
	answer(callId: number, allow: boolean): void;
}
export const appContext = createContext<AppServices>(Symbol("unlab-app"));

// ───────────────────────────── the one store binding ─────────────────────────────

/**
 * `new Select(this, s => …)` in a field. Subscribes on connect, unsubscribes on
 * disconnect, and requests an update only when the selected value changes
 * (Object.is by default; selectors are memoised so derived arrays keep their
 * identity). Lit coalesces the update to one render per microtask.
 */
export class Select<T> implements ReactiveController {
	#value!: T;
	constructor(
		private readonly host: ReactiveControllerHost & { app: AppServices },
		private readonly selector: (s: LabState) => T,
		private readonly equals: (a: T, b: T) => boolean = Object.is,
	) {
		host.addController(this);
	}
	get value(): T {
		return this.#value;
	}
	hostConnected(): void {
		throw new Error("not implemented"); // read now; subscribe; on notify compare and host.requestUpdate()
	}
	hostDisconnected(): void {
		throw new Error("not implemented");
	}
}

/** The capture list's binding: compares `revision` only, wakes at most once per animation frame (CaptureView coalesces). */
export class FollowCapture implements ReactiveController {
	constructor(host: ReactiveControllerHost & { app: AppServices }) {
		throw new Error("not implemented");
	}
	hostConnected(): void {}
	hostDisconnected(): void {}
}

/**
 * Base class: light DOM, services from context. No shadow roots anywhere:
 *   - ARIA IDREFs (aria-controls, aria-activedescendant, aria-describedby,
 *     the one live region) work across the whole app without reference-target;
 *   - WTerm's global stylesheet and its selection handling work unmodified;
 *   - one cascade: tokens.css, base.css (controls), then each element's own
 *     CSS file wrapped in `@scope (unlab-x) to (unlab-terminal)` inside
 *     `@layer components`, imported by the element module (Vite bundles it).
 */
export abstract class UnlabElement extends LitElement {
	// No decorators: ContextConsumer in a field. The provider (<unlab-app>, or a
	// fixture's <unlab-fixture>) is an ancestor, so the value arrives
	// synchronously during connectedCallback, before the first render.
	readonly #ctx = new ContextConsumer(this, { context: appContext });
	get app(): AppServices {
		const v = this.#ctx.value;
		if (!v) throw new Error(`${this.localName} rendered outside <unlab-app>`);
		return v;
	}
	protected override createRenderRoot(): HTMLElement {
		return this;
	}
}

// ───────────────────────────── a representative element ─────────────────────────────

/** The rail: rows from one memoised selector; clicking a row runs `focus` with source 'button'. */
export class UnlabRail extends UnlabElement {
	readonly #rows = new Select(this, selectRail);
	override render(): TemplateResult {
		return html`<ul role="list">
			${this.#rows.value.map(
				(r) => html`<li>
					<unlab-machine-row
						.row=${r}
						@click=${() => this.app.commands.focus.run({ target: r.name, mode: "plain" }, { source: "button", signal: AbortSignal.timeout(5_000) })}
					></unlab-machine-row>
				</li>`,
			)}
		</ul>`;
	}
}

/**
 * Properties are declared with `static properties` + `declare` fields, never
 * class-field initialisers: with useDefineForClassFields (target esnext) an
 * initialised field shadows Lit's accessor and the element never updates.
 * Most elements need none: they take a key (`machine`) and select the rest.
 */
export class UnlabPane extends UnlabElement {
	static override properties = { machine: { type: String, reflect: true } };
	declare machine: MachineName;
	// #pane = new Select(this, s => selectPane(s, this.machine))  — header, tabs, right-side word, legend
}

// ───────────────────────────── the terminal element ─────────────────────────────

/**
 * <unlab-terminal session="node2:sh1">. A socket, not an owner: on connect it
 * asks for its Screen and attaches it (moving the screen's element in); on
 * disconnect it detaches (the screen goes back to the garage, still parsing).
 * Changing `session` (tab switch) detaches one and attaches the other. Its
 * only rendering is the screen's own element plus the mark overlay layer.
 */
export class UnlabTerminal extends UnlabElement {
	static override properties = { session: { type: String }, focused: { type: Boolean } };
	declare session: SessionId;
	declare focused: boolean;
	override connectedCallback(): void {
		super.connectedCallback();
		throw new Error("not implemented");
	}
	override disconnectedCallback(): void {
		super.disconnectedCallback();
		throw new Error("not implemented");
	}
	/** The spec's element method, by row range. Implemented as Screen.beginMark/end; exposed for fixtures and tests. */
	mark(fromRow: number, toRow: number, source: "bar" | "agent"): void {
		throw new Error("not implemented");
	}
}

// ───────────────────────────── the command bar: a pure model + a thin element ─────────────────────────────

/**
 * ui/command-bar/model.ts. Every state the artboards draw is a variant here,
 * and every key is a transition, so the whole bar is unit-tested in Node
 * without a DOM. The element renders BarState and forwards keys.
 */
export type BarBlock =
	| { kind: "none" }
	| { kind: "preview"; preview: Preview }
	| { kind: "error"; error: LineError; line: string }
	| { kind: "confirm"; text: ConfirmText; line: string; approvalFor: string }
	| { kind: "running"; line: string }
	| { kind: "result"; result: Extract<Result, { kind: "report" }> };

export interface BarState {
	readonly open: boolean;
	readonly text: string;
	readonly cursor: number;
	readonly suggestions: readonly Suggestion[];
	readonly choice: number;
	readonly block: BarBlock;
	readonly hint: string; // 'tab → alpine', '↵ run', '↵ again to remove'
	readonly signature: { readonly parts: readonly string[]; readonly current: number } | null;
	readonly historyIndex: number | null;
}

export type BarKey =
	| { key: "text"; text: string; cursor: number }
	| { key: "tab" | "shift-tab" | "up" | "down" | "enter" | "mod-enter" | "escape" }
	| { key: "digit"; digit: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 };

/** What the element must do after a transition. Running is an output, not a side effect of the model. */
export type BarOutput =
	| { do: "run"; line: string; approval: Approval | null; keepOpen: boolean }
	| { do: "focus"; machine: MachineName } // 1..8 on empty input
	| { do: "close" };

export function barStep(s: BarState, k: BarKey, lab: LabState, commands: Registry): { state: BarState; out: readonly BarOutput[] } {
	throw new Error("not implemented");
	// enter: complete+valid → danger && !confirming ? confirm block : run
	//        incomplete → accept suggestion; no suggestion → error block (errors only on Enter)
	// confirming: enter → run with grantApproval(line); any text edit or escape → cancel confirm
	// escape: confirm showing → cancel it; else close (focus returns to keyboard.returnTo)
}

// ───────────────────────────── the rest of the element list ─────────────────────────────
// unlab-app (view switch; empty lab derived from rail.length === 0), unlab-top-bar,
// unlab-command-bar, unlab-machine-row, unlab-machine-details, unlab-pane-area
// (CSS grid from selectTiling, ResizeObserver → ui/area-resized, parked strip),
// unlab-pane, unlab-terminal, unlab-switch, unlab-port, unlab-capture (dock: tail(8);
// full: virtualised window()), unlab-mac-table, unlab-frame-detail, unlab-agent-panel,
// unlab-confirm, unlab-spawn-form, unlab-statusline, unlab-announcer (the one polite live region).

export declare function defineElements(): void; // customElements.define for each; called once by main.ts

// keep imports used for the sketch
export type _Used = [Command<{}>, HueNo, typeof selectStatus];
