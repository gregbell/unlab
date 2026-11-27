import "./mac-table.css";
import { html, nothing, type TemplateResult } from "lit";
import { macRows, macSeen, selectNames, switchLabel } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { FollowCapture } from "../capture/follow.ts";

/**
 * The addresses the switch has learned. A flushed entry stays, struck through,
 * until its port relearns it or the machine goes. The table is the switch's,
 * read while rendering: every frame can teach it, so it renders when the
 * capture does, and on the clock tick so `seen` keeps counting.
 */
export class UnlabMacTable extends UnlabElement {
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #shown = new Select(this, (s) => s.shownSwitch);
	readonly #label = new Select(this, (s) => switchLabel(s, s.shownSwitch));

	constructor() {
		super();
		new Select(this, (s) => s.now);
		new Select(this, selectNames);
		// Paused or not, every frame the switch accepts can teach it an address.
		new FollowCapture(this, (capture) => capture.counters.in);
	}

	override render(): TemplateResult {
		const now = this.app.switch.now();
		const label = this.#label.value;
		const entries = macRows(this.app.store.state, this.app.switch.macTable(this.#shown.value), now);
		const learned = entries.filter((e) => !e.flushed).length;
		return html`<div class="header">
				<h2 class="title">${label === null ? "" : `${label} `}mac address table</h2>
				<span class="count">${learned} learned</span>
			</div>
			<div class="scroll">
				<table>
					<thead>
						<tr><th scope="col">mac</th><th scope="col">port</th><th scope="col">machine</th><th scope="col">seen</th></tr>
					</thead>
					<tbody>
						${entries.map((e) => {
							const hue = e.machine === null ? undefined : this.#machines.value[e.machine]?.hue;
							return html`<tr data-flushed=${e.flushed}>
								<td class="mac">${e.mac}</td>
								<td>${e.port}</td>
								<td class="machine" title=${e.label || nothing} data-hue=${e.flushed ? nothing : (hue ?? nothing)}>${e.label}</td>
								<td class="seen">${macSeen(e)}</td>
							</tr>`;
						})}
					</tbody>
				</table>
				${entries.length === 0 ? html`<p class="empty">Nothing learned yet.</p>` : nothing}
			</div>`;
	}
}

customElements.define("unlab-mac-table", UnlabMacTable);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-mac-table": UnlabMacTable;
	}
}
