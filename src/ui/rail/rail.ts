import "./rail.css";
import "../machine-details/machine-details.ts";
import "../machine-row/machine-row.ts";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { machineList, memoryGiven, PORTS, selectRail, selectSubnets } from "../../model/index.ts";
import { plusIcon, Select, UnlabElement } from "../base/index.ts";

/**
 * The machine rail: how many machines and the memory that those that run were
 * given, one row per machine in spawn order, then the details of the one with
 * the keyboard. An empty lab has no dock, so the rail names the
 * switches at its foot instead.
 */
export class UnlabRail extends UnlabElement {
	readonly #rows = new Select(this, selectRail);
	readonly #switches = new Select(this, (s) => s.switches);
	readonly #memory = new Select(this, (s) => memoryGiven(machineList(s)));

	override render(): TemplateResult {
		const rows = this.#rows.value;
		return html`<div class="header">
				<h2>machines <span>${rows.length}</span> ${
					rows.length === 0
						? nothing
						: html`<span aria-hidden="true">·</span> <span class="memory" title="Memory given to the machines that are running">${this.#memory.value} MiB<span class="visually-hidden"> of memory</span></span>`
				}</h2>
				<button type="button" class="add" aria-label="Add machines" title="Add machines"
					@click=${() => this.app.store.dispatchUi({ type: "ui/view", view: "spawn" })}>${plusIcon}</button>
			</div>
			${
				rows.length === 0
					? html`<p class="empty">Nothing booted yet.</p>
							<div class="switch">
								${this.#switches.value.map(
									(name) => html`<p><span class="name">${name}</span><span>0 of ${PORTS.length} ports</span></p>
										<p>L2 · ${selectSubnets(name)(this.app.store.state)}</p>`,
								)}
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
