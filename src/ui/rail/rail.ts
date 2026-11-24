import "./rail.css";
import "../machine-details/machine-details.ts";
import "../machine-row/machine-row.ts";
import { html, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { PORTS, SWITCH_NAME, selectRail, selectSubnets } from "../../model/index.ts";
import { plusIcon, Select, UnlabElement } from "../base/index.ts";

/**
 * The machine rail: one row per machine in spawn order, then the details of
 * the one with the keyboard. An empty lab has no dock, so the rail names the
 * switch at its foot instead.
 */
export class UnlabRail extends UnlabElement {
	readonly #rows = new Select(this, selectRail);

	override render(): TemplateResult {
		const rows = this.#rows.value;
		return html`<div class="header">
				<h2>machines <span>${rows.length}</span></h2>
				<button type="button" class="add" aria-label="Add machines" title="Add machines"
					@click=${() => this.app.store.dispatchUi({ type: "ui/view", view: "spawn" })}>${plusIcon}</button>
			</div>
			${
				rows.length === 0
					? html`<p class="empty">Nothing booted yet.</p>
							<div class="switch">
								<p><span class="name">${SWITCH_NAME}</span><span>0 of ${PORTS.length} ports</span></p>
								<p>L2 · ${selectSubnets(this.app.store.state)}</p>
							</div>`
					: html`<ul role="list" class="rows">
							${repeat(
								rows,
								(row) => row.name,
								(row) => html`<li><unlab-machine-row .row=${row}></unlab-machine-row></li>`,
							)}
						</ul>`
			}
			<unlab-machine-details></unlab-machine-details>`;
	}
}

customElements.define("unlab-rail", UnlabRail);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-rail": UnlabRail;
	}
}
