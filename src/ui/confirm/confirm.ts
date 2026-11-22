import "./confirm.css";
import { html, nothing, type TemplateResult } from "lit";
import { Select, UnlabElement } from "../base/index.ts";
import { hued } from "./hued.ts";

let ids = 0;

/**
 * The one block that waits for a yes: a question naming the machine, what is
 * lost, and a button named for the action. The command bar shows it for `rm`;
 * agent approvals show it too. It decides nothing: the primary button fires
 * `unlab-approve` and `Keep it` fires `unlab-keep`, both bubbling.
 *
 * `heading` rather than the handoff's `title`, which every element already has
 * as its tooltip.
 */
export class UnlabConfirm extends UnlabElement {
	static override properties = {
		heading: {},
		detail: {},
		actionLabel: { attribute: "action-label" },
		keys: { type: Boolean },
	};
	declare heading: string;
	declare detail: string;
	/** `Remove node3`, never OK or Allow. */
	declare actionLabel: string;
	/** Show the keys beside the buttons, where Enter and Esc answer, as in the command bar. */
	declare keys: boolean;

	readonly #machines = new Select(this, (s) => s.machines);
	readonly #id = `unlab-confirm-${++ids}`;

	constructor() {
		super();
		this.heading = "";
		this.detail = "";
		this.actionLabel = "";
		this.keys = false;
	}

	override render(): TemplateResult {
		const machines = this.#machines.value;
		const key = (text: string) => (this.keys ? html`<span class="key" aria-hidden="true">${text}</span>` : nothing);
		return html`<div class="block" role="group" aria-labelledby=${this.#id}>
			<p class="heading" id=${this.#id}>${hued(this.heading, machines)}</p>
			<p class="detail">${hued(this.detail, machines)}</p>
			<div class="actions">
				<button type="button" class="button primary md" @click=${() => this.#emit("unlab-approve")}>
					${this.actionLabel}${key("↵")}
				</button>
				<button type="button" class="button md" @click=${() => this.#emit("unlab-keep")}>Keep it${key("esc")}</button>
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
