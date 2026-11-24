import "./mac-table.css";
import { html, nothing, type TemplateResult } from "lit";
import { selectNames, severalNics } from "../../model/index.ts";
import { nameOf, nicLabel, nicOfMac, parseMac } from "../../net/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { FollowCapture } from "../capture/follow.ts";

/**
 * The addresses switch0 has learned. A flushed entry stays, struck through,
 * until its port relearns it or the machine goes. The table is the switch's,
 * read while rendering: every frame can teach it, so it renders when the
 * capture does, and on the clock tick so `seen` keeps counting.
 */
export class UnlabMacTable extends UnlabElement {
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #names = new Select(this, selectNames);

	constructor() {
		super();
		new Select(this, (s) => s.now);
		// Paused or not, every frame the switch accepts can teach it an address.
		new FollowCapture(this, (capture) => capture.counters.in);
	}

	override render(): TemplateResult {
		const now = this.app.switch.now();
		const entries = [...this.app.switch.macTable()].sort((a, b) => a.port - b.port || a.mac.localeCompare(b.mac));
		const learned = entries.filter((e) => !e.flushed).length;
		return html`<div class="header">
				<h2 class="title">mac address table</h2>
				<span class="count">${learned} learned</span>
			</div>
			<div class="scroll">
				<table>
					<thead>
						<tr><th scope="col">mac</th><th scope="col">port</th><th scope="col">machine</th><th scope="col">seen</th></tr>
					</thead>
					<tbody>
						${entries.map((e) => {
							const at = nicOfMac(parseMac(e.mac), 0);
							const machines = this.#machines.value;
							const name = at && nameOf(this.#names.value, at.n);
							const hue = name === null ? undefined : machines[name]?.hue;
							const label = !at || name === null ? "" : nicLabel(name, at.nic, severalNics({ machines }, name));
							return html`<tr data-flushed=${e.flushed}>
								<td class="mac">${e.mac}</td>
								<td>${e.port}</td>
								<td class="machine" title=${label || nothing} data-hue=${e.flushed ? nothing : (hue ?? nothing)}>${label}</td>
								<td class="seen">
									${e.flushed ? "flushed, link down" : `${Math.max(0, Math.floor((now - e.seen) / 1000))} s ago`}
								</td>
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
