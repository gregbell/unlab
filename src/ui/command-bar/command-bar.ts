import "./command-bar.css";
import "../confirm/confirm.ts";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { isLineError, type LineError, type Result } from "../../commands/index.ts";
import type { LabState, SessionId } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { errorBlock, politeBlock, resultBlock, rowContent, signatureRow } from "./blocks.ts";
import {
	type BarEffect,
	type BarInput,
	type BarRow,
	type BarState,
	type BarView,
	barStep,
	barView,
	RESTING,
} from "./model.ts";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = MAC ? { label: "⌘K", aria: "Meta+K" } : { label: "Ctrl+/", aria: "Control+/" };
const PLACEHOLDER = "Command bar";
const INPUT = "command-bar-input";
const LISTBOX = "command-bar-suggestions";
const optionId = (row: number): string => `command-bar-option-${row}`;

type Run = Extract<BarEffect, { type: "run" }>;

/** ⌘K on macOS. Ctrl+K cuts to the end of a shell line, so elsewhere it is Ctrl+/. */
function isShortcut(event: KeyboardEvent): boolean {
	if (event.altKey) return false;
	if (MAC) return event.metaKey && !event.ctrlKey && event.key.toLowerCase() === "k";
	return event.ctrlKey && !event.metaKey && (event.key === "/" || event.code === "Slash");
}

/** The bar's own keys; anything else is typing. */
function keyInput(event: KeyboardEvent): BarInput | null {
	if (event.altKey || event.isComposing) return null;
	const mod = event.metaKey || event.ctrlKey;
	switch (event.key) {
		case "Tab":
			return mod ? null : { kind: event.shiftKey ? "shift-tab" : "tab" };
		case "ArrowUp":
			return mod || event.shiftKey ? null : { kind: "up" };
		case "ArrowDown":
			return mod || event.shiftKey ? null : { kind: "down" };
		case "Enter":
			return { kind: "enter", keepOpen: mod };
		case "Escape":
			return { kind: "escape" };
	}
	if (!mod && !event.shiftKey && /^[1-8]$/.test(event.key)) return { kind: "digit", digit: Number(event.key) };
	return null;
}

const CARET_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

const GROUP_LABELS: Readonly<Record<BarRow["kind"], string | null>> = {
	recent: "recent",
	verb: "verbs",
	fix: "did you mean",
	value: null,
};

interface Group {
	readonly label: string | null;
	readonly first: number;
	readonly rows: readonly BarRow[];
}

function groupsOf(rows: readonly BarRow[]): Group[] {
	const groups: { label: string | null; first: number; rows: BarRow[]; kind: BarRow["kind"] }[] = [];
	rows.forEach((row, i) => {
		const last = groups.at(-1);
		if (last?.kind === row.kind) last.rows.push(row);
		else groups.push({ label: GROUP_LABELS[row.kind], first: i, rows: [row], kind: row.kind });
	});
	return groups;
}

/**
 * The app's command line. At rest it is the 28px field in the top bar; open,
 * it is a 720px panel over the lab whose top-left corner sits on the field's.
 *
 * Every decision is `barStep`'s: this element forwards keys, edits and clicks
 * to it, renders `barView`, and carries out the effects. While it is open the
 * lab's keyboard is the bar's (`ui/bar`), so no terminal takes keys.
 */
export class UnlabCommandBar extends UnlabElement {
	readonly #lab = new Select(this, (s: LabState) => s);
	readonly #lastLine = new Select(this, (s) => s.log.at(-1)?.line ?? null);
	#bar: BarState = RESTING;
	/** Where focus was before the bar opened, to give it back on close. */
	#returnTo: HTMLElement | null = null;
	/** The app that hears `confirmInBar`; kept, because once this element leaves it `closest` finds nothing. */
	#appElement: Element | null = null;
	readonly #runs = new Map<number, AbortController>();

	get #input(): HTMLInputElement | null {
		return this.querySelector(`#${INPUT}`);
	}

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("keydown", this.#onShortcut, { capture: true });
		this.#appElement = this.closest("unlab-app");
		this.#appElement?.addEventListener("unlab-open-bar", this.#onOpenBar);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.#onShortcut, { capture: true });
		this.#appElement?.removeEventListener("unlab-open-bar", this.#onOpenBar);
		this.#appElement = null;
		document.removeEventListener("pointerdown", this.#onOutside, { capture: true });
		for (const controller of this.#runs.values()) controller.abort();
		this.#runs.clear();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		this.toggleAttribute("open", this.#bar.open);
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const input = this.#input;
		if (!input || !this.#bar.open) return;
		const { caret } = this.#bar;
		if (input.selectionStart === input.selectionEnd && input.selectionStart !== caret) {
			input.setSelectionRange(caret, caret);
		}
		this.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}

	override render(): TemplateResult {
		const bar = this.#bar;
		const lab = this.#lab.value;
		const view = bar.open ? barView(bar, lab, this.app.commands.registry) : null;
		const chosen = view?.chosen ?? null;
		const hint = view
			? html`<span class="hint" data-tone=${bar.open && bar.mode.kind === "confirm" ? "warn" : "plain"}>${view.hint}</span>`
			: html`<kbd class="hint" aria-hidden="true">${SHORTCUT.label}</kbd>`;
		return html`<div class="panel" @pointerdown=${this.#onFieldPointer} @focusout=${this.#onFocusOut}>
			<div class="input-row">
				<label class="prompt" for=${INPUT}>:</label>
				<input
					id=${INPUT}
					type="text"
					role="combobox"
					aria-label="Command"
					aria-keyshortcuts=${SHORTCUT.aria}
					aria-autocomplete="list"
					aria-expanded=${view !== null && view.rows.length > 0 ? "true" : "false"}
					aria-controls=${LISTBOX}
					aria-activedescendant=${chosen === null ? nothing : optionId(chosen)}
					autocomplete="off"
					spellcheck="false"
					placeholder=${bar.open ? "type a verb, or pick one below" : (this.#lastLine.value ?? PLACEHOLDER)}
					.value=${live(bar.open ? bar.text : "")}
					@input=${this.#onInput}
					@keydown=${this.#onKeydown}
					@keyup=${this.#onKeyup}
					@click=${this.#onCaret}
				/>
				${hint}
			</div>
			${view ? this.#body(view, lab) : this.#listbox([], null, lab)}
		</div>`;
	}

	#body(view: BarView, lab: LabState): TemplateResult {
		const { block, rows, chosen } = view;
		const fixes = rows.some((row) => row.kind === "fix");
		return html`${signatureRow(view.signature)} ${fixes ? nothing : this.#listbox(rows, chosen, lab)}
			<div class="live" role="status">${politeBlock(block, lab)}</div>
			${block.kind === "error" ? errorBlock(block) : nothing}
			${
				block.kind === "confirm"
					? html`<div class="confirm">
						<unlab-confirm
							keys
							.heading=${block.confirm.question}
							.detail=${block.confirm.detail}
							.actionLabel=${block.confirm.actionLabel}
							@unlab-approve=${() => this.#stepAndRefocus({ kind: "approve" })}
							@unlab-keep=${() => this.#stepAndRefocus({ kind: "keep" })}
						></unlab-confirm>
					</div>`
					: nothing
			}
			${block.kind === "result" ? resultBlock(block, lab, this.#openConsole) : nothing}
			${fixes ? this.#listbox(rows, chosen, lab) : nothing}
			<div class="keys">${view.footer.map((key) => html`<span>${key}</span>`)}</div>`;
	}

	/** Always in the DOM, so the combobox's `aria-controls` always names something. */
	#listbox(rows: readonly BarRow[], chosen: number | null, lab: LabState): TemplateResult {
		const values = rows.length > 0 && rows.every((row) => row.kind === "value");
		const option = (row: BarRow, i: number) => html`<div
			class="row"
			role="option"
			id=${optionId(i)}
			aria-selected=${i === chosen ? "true" : "false"}
			data-kind=${row.kind}
			data-source=${row.kind === "recent" ? row.source : nothing}
			@mousedown=${(event: Event) => event.preventDefault()}
			@click=${() => this.#step({ kind: "choose", row: i })}
		>
			${rowContent(row, lab)}
		</div>`;
		return html`<div id=${LISTBOX} role="listbox" aria-label="Suggestions" class=${values ? "values" : ""} ?hidden=${rows.length === 0}>
			${groupsOf(rows).map((group) => {
				const options = group.rows.map((row, i) => option(row, group.first + i));
				if (group.label === null) return options;
				const id = `command-bar-group-${group.first}`;
				return html`<div role="group" aria-labelledby=${id}>
					<div class="group-label" id=${id}>${group.label}</div>
					${options}
				</div>`;
			})}
		</div>`;
	}

	/** One input through the model, then its effects in order. */
	#step(input: BarInput): readonly BarEffect[] {
		const before = this.#bar;
		const { bar, effects } = barStep(before, input, this.app.store.state, this.app.commands.registry);
		this.#bar = bar;
		if (!before.open && bar.open) this.#opened();
		for (const effect of effects) this.#perform(effect);
		this.requestUpdate();
		return effects;
	}

	#stepAndRefocus(input: BarInput): void {
		this.#step(input);
		if (this.#bar.open) this.#input?.focus();
	}

	#opened(): void {
		const active = document.activeElement;
		this.#returnTo =
			active instanceof HTMLElement && active !== document.body && !this.contains(active) ? active : null;
		this.app.store.dispatchUi({ type: "ui/bar", open: true });
		document.addEventListener("pointerdown", this.#onOutside, { capture: true });
		void this.updateComplete.then(() => {
			if (this.#bar.open) this.#input?.focus();
		});
	}

	#perform(effect: BarEffect): void {
		switch (effect.type) {
			case "run":
				this.#run(effect);
				return;
			case "abort":
				this.#runs.get(effect.run)?.abort();
				this.#runs.delete(effect.run);
				return;
			case "close":
				document.removeEventListener("pointerdown", this.#onOutside, { capture: true });
				this.app.store.dispatchUi({ type: "ui/bar", open: false });
				return;
			case "focus-return":
				this.#giveFocusBack();
				return;
			case "pass":
				return;
		}
	}

	#run(effect: Run): void {
		const controller = new AbortController();
		this.#runs.set(effect.run, controller);
		this.#execute(effect, controller.signal)
			.catch((error: unknown): LineError => ({ message: error instanceof Error ? error.message : String(error) }))
			.then((result) => {
				if (this.#runs.get(effect.run) !== controller) return;
				this.#runs.delete(effect.run);
				this.#step({ kind: "ran", run: effect.run, result });
			});
	}

	/** A dangerous line runs on its own parse, with the approval the second Enter granted. */
	async #execute(effect: Run, signal: AbortSignal): Promise<Result | LineError> {
		const { commands } = this.app;
		if (effect.approval === null) return commands.run(effect.line, effect.source, signal);
		const parsed = commands.parse(effect.line);
		if (isLineError(parsed)) return parsed;
		if (!parsed.danger) return commands.run(effect.line, effect.source, signal);
		return parsed.run({ source: effect.source, signal, approval: effect.approval });
	}

	#giveFocusBack(): void {
		const target = this.#returnTo;
		this.#returnTo = null;
		if (!target?.isConnected) return;
		// A pane that gets the keyboard back puts focus in its terminal itself.
		if (this.app.store.state.keyboard.kind === "pane" && target.closest("unlab-pane-area")) return;
		target.focus();
	}

	readonly #openConsole = (session: SessionId): void => {
		this.#step({ kind: "open-console", session });
	};

	/** Capture phase on window, so the shortcut wins over a focused terminal. */
	readonly #onShortcut = (event: KeyboardEvent): void => {
		if (!isShortcut(event)) return;
		event.preventDefault();
		event.stopPropagation();
		this.#step({ kind: "open" });
		this.#input?.focus();
	};

	readonly #onOpenBar = (event: Event): void => {
		const line = event instanceof CustomEvent ? event.detail : undefined;
		if (typeof line !== "string") return;
		this.#step({ kind: "open-confirming", line });
	};

	readonly #onFieldPointer = (): void => {
		if (!this.#bar.open) this.#step({ kind: "open" });
	};

	readonly #onOutside = (event: PointerEvent): void => {
		if (event.target instanceof Node && this.contains(event.target)) return;
		this.#step({ kind: "dismiss" });
	};

	/** Tab passes on out of the bar, and the bar closes behind it. */
	readonly #onFocusOut = (event: FocusEvent): void => {
		const to = event.relatedTarget;
		if (this.#bar.open && to instanceof Node && !this.contains(to)) this.#step({ kind: "dismiss" });
	};

	readonly #onInput = (event: Event): void => {
		const input = event.currentTarget;
		if (!(input instanceof HTMLInputElement)) return;
		if (!this.#bar.open) this.#step({ kind: "open" });
		this.#step({ kind: "edit", text: input.value, caret: input.selectionStart ?? input.value.length });
	};

	readonly #onKeydown = (event: KeyboardEvent): void => {
		const input = keyInput(event);
		if (input === null) return;
		// A held Enter repeats. Each Enter must be its own press, or holding it would confirm a removal by itself.
		if (input.kind === "enter" && event.repeat) {
			event.preventDefault();
			return;
		}
		if (!this.#bar.open) {
			if (input.kind !== "enter" && input.kind !== "down" && input.kind !== "up") return;
			event.preventDefault();
			this.#step({ kind: "open" });
			return;
		}
		const effects = this.#step(input);
		if (!effects.some((effect) => effect.type === "pass")) event.preventDefault();
	};

	readonly #onKeyup = (event: KeyboardEvent): void => {
		if (CARET_KEYS.has(event.key)) this.#onCaret();
	};

	readonly #onCaret = (): void => {
		const input = this.#input;
		if (!input || !this.#bar.open || input.value !== this.#bar.text) return;
		const caret = input.selectionStart ?? input.value.length;
		if (caret !== this.#bar.caret) this.#step({ kind: "edit", text: input.value, caret });
	};
}

customElements.define("unlab-command-bar", UnlabCommandBar);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-command-bar": UnlabCommandBar;
	}
}
