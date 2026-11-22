import "./terminal.css";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionId } from "../../model/index.ts";
import { UnlabElement } from "../base/index.ts";
import type { TerminalHost } from "../services.ts";

/**
 * <unlab-terminal session="node2:sh1">: the socket a session's screen renders
 * into, once, for the session's life. Panes never move, so this element never
 * moves either; it only passes on whether it is shown and whether it has the
 * keyboard, and draws the line-mark rules in the gutter after each render.
 */
export class UnlabTerminal extends UnlabElement {
	static override properties = {
		session: { type: String, reflect: true },
		visible: { type: Boolean },
		focused: { type: Boolean },
	};
	declare session: SessionId;
	/** Shown on screen. A hidden screen keeps parsing and stops painting. */
	declare visible: boolean;
	/** Has the keyboard. Setting it moves DOM focus into the screen; clearing it gives focus up only if the screen held it. */
	declare focused: boolean;

	#host: TerminalHost | null = null;
	#unrender: (() => void) | null = null;
	/** What the screen was last told, so it is told only of changes: telling it `focused` again would take focus again. */
	#told: { visible: boolean; focused: boolean } | null = null;

	constructor() {
		super();
		this.visible = false;
		this.focused = false;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		if (this.#host) this.#listen(this.#host);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.#unrender?.();
		this.#unrender = null;
	}

	override render(): TemplateResult {
		const marks = this.#host?.marks() ?? [];
		return html`<div class="screen"></div>
			<div class="gutter" aria-hidden="true">
				${repeat(
					marks,
					(mark) => html`<span
						class="rule"
						data-source=${mark.source}
						style="--from: ${mark.fromRow}; --rows: ${mark.toRow - mark.fromRow + 1}"
					></span>`,
				)}
			</div>`;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const host = this.#host ?? this.#attach();
		if (!host) return;
		const told = this.#told;
		// Shown before focused: a screen cannot take focus while it is hidden.
		if (told?.visible !== this.visible) host.setVisible(this.visible);
		if (told?.focused !== this.focused) host.setFocused(this.focused);
		this.#told = { visible: this.visible, focused: this.focused };
	}

	/** The screen is created by the same event that adds the session, so it is there by the first render; if not, the next render tries again. */
	#attach(): TerminalHost | null {
		const host = this.app.terminals.host(this.session);
		const screen = this.querySelector<HTMLElement>(":scope > .screen");
		if (!host || !screen) return null;
		this.#host = host;
		host.mount(screen);
		this.#listen(host);
		return host;
	}

	#listen(host: TerminalHost): void {
		this.#unrender?.();
		this.#unrender = host.onRender(() => this.requestUpdate());
	}
}

customElements.define("unlab-terminal", UnlabTerminal);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-terminal": UnlabTerminal;
	}
}
