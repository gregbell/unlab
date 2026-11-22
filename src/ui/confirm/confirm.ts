import "./confirm.css";
import { html, nothing, type TemplateResult } from "lit";
import { Select, UnlabElement } from "../base/index.ts";
import { hued } from "./hued.ts";

let ids = 0;

/**
 * The one block that waits for a yes: a question naming the machine, what is
 * lost, and a button named for the action. The command bar shows it for `rm`;
 * agent approvals show it too. It decides nothing: the primary button fires
 * `unlab-approve` and the other button (`Keep it`, or `Deny` for an agent) fires `unlab-keep`, both bubbling.
 *
 * `heading` rather than the handoff's `title`, which every element already has
 * as its tooltip.
 */
export class UnlabConfirm extends UnlabElement {
	static override properties = {
		heading: {},
		detail: {},
		actionLabel: { attribute: "action-label" },
		keepLabel: { attribute: "keep-label" },
		note: {},
		keys: { type: Boolean },
		armed: { type: Boolean },
	};
	declare heading: string;
	declare detail: string;
	/** `Remove node3`, never OK or Allow. */
	declare actionLabel: string;
	/** The other button. An agent approval says `Deny`. */
	declare keepLabel: string;
	/** A line above the heading in --warn, such as `8 · waiting for you`. */
	declare note: string;
	/** Show the keys beside the buttons, where Enter and Esc answer, as in the command bar. */
	declare keys: boolean;
	/** False holds the action button disabled. Keep it, or Deny, always works. */
	declare armed: boolean;

	readonly #machines = new Select(this, (s) => s.machines);
	readonly #id = `unlab-confirm-${++ids}`;

	constructor() {
		super();
		this.heading = "";
		this.detail = "";
		this.actionLabel = "";
		this.keepLabel = "Keep it";
		this.note = "";
		this.keys = false;
		this.armed = true;
	}

	override render(): TemplateResult {
		const machines = this.#machines.value;
		const key = (text: string) => (this.keys ? html`<span class="key" aria-hidden="true">${text}</span>` : nothing);
		return html`<div class="block" role="group" aria-labelledby=${this.#id}>
			${this.note ? html`<p class="note">${this.note}</p>` : nothing}
			<p class="heading" id=${this.#id}>${hued(this.heading, machines)}</p>
			<p class="detail">${hued(this.detail, machines)}</p>
			<div class="actions">
				<button type="button" class="button primary md" ?disabled=${!this.armed} @click=${() => this.#emit("unlab-approve")}>
					${this.actionLabel}${key("↵")}
				</button>
				<button type="button" class="button md" @click=${() => this.#emit("unlab-keep")}>${this.keepLabel}${key("esc")}</button>
			</div>
		</div>`;
	}

	#emit(type: "unlab-approve" | "unlab-keep"): void {
		this.dispatchEvent(new CustomEvent(type, { bubbles: true }));
	}
}

customElements.define("unlab-confirm", UnlabConfirm);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-confirm": UnlabConfirm;
	}
	interface HTMLElementEventMap {
		"unlab-approve": CustomEvent<undefined>;
		"unlab-keep": CustomEvent<undefined>;
	}
}
