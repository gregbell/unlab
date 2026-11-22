import "./rail.css";
import "../machine-details/machine-details.ts";
import "../machine-row/machine-row.ts";
import { html, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { selectRail } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

/** The machine rail: one row per machine in spawn order, then the details of the one with the keyboard. */
export class UnlabRail extends UnlabElement {
	readonly #rows = new Select(this, selectRail);

	override render(): TemplateResult {
		const rows = this.#rows.value;
		return html`<h2 class="header"><span>machines</span><span>${rows.length}</span></h2>
			${
				rows.length === 0
					? html`<p class="empty">Nothing booted yet.</p>`
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
