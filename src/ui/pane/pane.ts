import "./pane.css";
import "../terminal/terminal.ts";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
	ACCEPTS,
	type MachineName,
	type RailRow,
	type SessionId,
	selectFocused,
	selectRail,
	sessionLabel,
} from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

type Tone = "address" | "booting" | "down";

/** The right side of the header: the address, or the one thing wrong. */
function rightSide(word: RailRow["word"], address: string): { readonly text: string; readonly tone: Tone } {
	switch (word) {
		case "up":
		case "unplugged":
			return { text: address, tone: "address" };
		case "cut":
			return { text: "cable cut", tone: "down" };
		case "failed":
			return { text: "failed", tone: "down" };
		case "removing":
			return { text: "removing", tone: "address" };
		default:
			return { text: word, tone: "booting" };
	}
}

/** A session's tab and panel ids. Colons are legal in an id but not in a selector, so they go. */
const tabId = (session: SessionId): string => `tab-${session.replace(":", "-")}`;
const panelId = (session: SessionId): string => `panel-${session.replace(":", "-")}`;

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * One machine's pane: the focus bar, the header with its session tabs, and one
 * terminal per session. Inactive tabs are hidden, never unmounted, so every
 * terminal keeps its screen for the session's life.
 *
 * The pane with the keyboard puts DOM focus in its active terminal. A booting,
 * failed or departing machine takes no keys, so its terminal never holds focus.
 */
export class UnlabPane extends UnlabElement {
	static override properties = { machine: { type: String, reflect: true } };
	declare machine: MachineName;

	readonly #machine = new Select(this, (s) => s.machines[this.machine]);
	readonly #word = new Select(this, (s) => selectRail(s).find((row) => row.name === this.machine)?.word);
	/** Highlighted: it has the keyboard, or gets it back when the command bar closes. */
	readonly #focused = new Select(this, (s) => selectFocused(s) === this.machine);
	/** Holds the keyboard right now. While the bar is open nothing in a pane does. */
	readonly #keyboard = new Select(this, (s) => s.keyboard.kind === "pane" && s.keyboard.machine === this.machine);
	readonly #shown = new Select(this, (s) => s.view === "lab" && s.panes.parked[this.machine] === undefined);
	readonly #maximised = new Select(this, (s) => s.panes.maximised?.machine === this.machine);
	readonly #sessions = new Select(this, (s) => s.sessions);
	readonly #agentPanel = new Select(this, (s) => s.agentPanel);

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		const machine = this.#machine.value;
		if (machine) this.dataset.hue = String(machine.hue);
		this.toggleAttribute("focused", this.#focused.value);
		this.toggleAttribute("maximised", this.#maximised.value);
		this.inert = machine?.life.phase === "removing";
	}

	override render(): TemplateResult | typeof nothing {
		const machine = this.#machine.value;
		const word = this.#word.value;
		if (!machine || !word) return nothing;
		const { name, life, sessions, activeSession } = machine;
		const takesKeys = ACCEPTS[life.phase].commands;
		const removing = life.phase === "removing";
		const right = rightSide(word, machine.ip);
		const shown = this.#shown.value && !removing;
		const keyboard = this.#keyboard.value && takesKeys;
		const states = this.#sessions.value;
		const legend = this.#agentPanel.value && sessions.some((id) => states[id]?.agentLines);
		return html`<div class="header" @mousedown=${this.#keepFocus} @click=${this.#onClick} @dblclick=${this.#onDoubleClick}>
				<span class="name">${name}</span>
				<div class="tabs" role="tablist" aria-label="Sessions on ${name}" @keydown=${this.#onTabKey}>
					${repeat(
						sessions,
						(id) => id,
						(id) => html`<button
							type="button"
							class="tab"
							role="tab"
							id=${tabId(id)}
							aria-controls=${panelId(id)}
							aria-selected=${id === activeSession ? "true" : "false"}
							tabindex=${id === activeSession ? 0 : -1}
							@click=${() => this.#selectTab(id)}
						>
							${sessionLabel(id)}
						</button>`,
					)}
				</div>
				${
					takesKeys
						? html`<button type="button" class="new-shell" aria-label="New shell on ${name}" @click=${this.#newShell}>+</button>`
						: nothing
				}
				<span class="fill"></span>
				${legend ? html`<span class="legend"><span class="swatch"></span>blue rule: sent by the agent</span>` : nothing}
				<span class="word" data-tone=${right.tone}>${right.text}</span>
				<button
					type="button"
					class="icon"
					aria-label="Maximise ${name}"
					aria-pressed=${this.#maximised.value ? "true" : "false"}
					@click=${this.#maximise}
				>
					<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"></rect></svg>
				</button>
				<button type="button" class="icon" aria-label="Park ${name}" @click=${this.#park}>
					<svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2 10h8"></path></svg>
				</button>
			</div>
			<div class="body" @click=${this.#onClick} @focusin=${takesKeys ? nothing : this.#refuseKeys}>
				${repeat(
					sessions,
					(id) => id,
					(id) => html`<div
						class="panel"
						role="tabpanel"
						id=${panelId(id)}
						aria-labelledby=${tabId(id)}
						aria-busy=${states[id]?.state === "opening" ? "true" : "false"}
						?hidden=${removing || id !== activeSession}
						@focusin=${this.#takeKeyboard}
					>
						<unlab-terminal
							session=${id}
							.visible=${shown && id === activeSession}
							.focused=${keyboard && shown && id === activeSession}
						></unlab-terminal>
					</div>`,
				)}
				${
					life.phase === "failed"
						? html`<div class="failure">
								<p class="headline">${name} did not boot.</p>
								${life.reason ? html`<p class="reason">${life.reason}</p>` : nothing}
								<div class="actions">
									<button type="button" class="button primary" @click=${() => this.runLine(`boot ${name}`)}>Boot again</button>
									<button type="button" class="button" @click=${() => this.app.commands.confirmInBar(`rm ${name}`)}>Remove</button>
								</div>
							</div>`
						: nothing
				}
				${removing ? html`<p class="removing">Removing ${name}.</p>` : nothing}
			</div>`;
	}

	#ui(type: "ui/pane-focused" | "ui/maximise" | "ui/park"): void {
		this.app.store.dispatchUi({ type, machine: this.machine });
	}

	#takeKeyboard = (): void => {
		if (!this.#keyboard.value) this.#ui("ui/pane-focused");
	};

	/** A click in the header leaves DOM focus where it was, so the terminal keeps the keys. */
	#keepFocus = (event: MouseEvent): void => {
		event.preventDefault();
	};

	/** Anywhere in the header but a button; the buttons say for themselves what a click means. */
	#onDoubleClick = (event: MouseEvent): void => {
		if (event.target instanceof Element && event.target.closest("button")) return;
		this.#ui("ui/maximise");
	};

	#onClick = (event: MouseEvent): void => {
		if (event.target instanceof Element && event.target.closest("button")) return;
		this.#takeKeyboard();
	};

	/** Keys typed into a machine that has no shell would go nowhere, or to the next prompt. */
	#refuseKeys = (event: FocusEvent): void => {
		if (event.target instanceof HTMLElement && event.target.closest("unlab-terminal")) event.target.blur();
	};

	#selectTab(session: SessionId): void {
		if (this.#machine.value?.activeSession !== session) {
			this.app.store.dispatchUi({ type: "ui/tab-selected", session });
		}
		this.#takeKeyboard();
	}

	#newShell = (): void => {
		this.#takeKeyboard();
		this.runLine(`sh ${this.machine}`);
	};

	#maximise = (): void => this.#ui("ui/maximise");
	#park = (): void => this.#ui("ui/park");

	/**
	 * Arrow keys move along the tab row, and Enter or Space opens the tab. Only
	 * opening moves the keyboard into that terminal, so the row stays walkable.
	 */
	#onTabKey = (event: KeyboardEvent): void => {
		if (!NAV_KEYS.has(event.key)) return;
		const tabs = [...this.querySelectorAll<HTMLButtonElement>(".tabs > [role=tab]")];
		const at = tabs.findIndex((tab) => tab === document.activeElement);
		if (at < 0) return;
		event.preventDefault();
		const last = tabs.length - 1;
		const to =
			event.key === "Home"
				? 0
				: event.key === "End"
					? last
					: event.key === "ArrowRight"
						? (at + 1) % tabs.length
						: (at + last) % tabs.length;
		tabs[to]?.focus();
	};
}

customElements.define("unlab-pane", UnlabPane);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-pane": UnlabPane;
	}
}
