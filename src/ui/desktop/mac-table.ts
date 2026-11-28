import { html, nothing, type TemplateResult } from "lit";
import { macRows, macSeen, type SwitchName, selectNames, totalsText } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { FollowCapture } from "../capture/follow.ts";

/**
 * A switch's counters and the addresses it has learned, in its details
 * window, in the words `macs` uses. A flushed entry stays until its port
 * relearns it or the machine goes. Neither is in the store: every frame can
 * change them, so this renders when the capture counts one, and on the clock
 * tick so `seen` keeps counting.
 */
export class UnlabMacTable extends UnlabElement {
	static override properties = { switch: { attribute: false } };
	declare switch: SwitchName;

	constructor() {
		super();
		new Select(this, (s) => s.now);
		new Select(this, (s) => s.machines);
		new Select(this, selectNames);
		new FollowCapture(this, (capture) => capture.counters.in);
	}

	override render(): TemplateResult {
		const name = this.switch;
		const entries = macRows(this.app.store.state, this.app.switch.macTable(name), this.app.switch.now());
		return html`<h3>Counters</h3><dl><div><dt>Frames</dt><dd>${totalsText(this.app.switch.totals(name))}</dd></div>
			<div><dt>Addresses learned</dt><dd>${entries.filter((e) => !e.flushed).length}</dd></div></dl>
			<h3>MAC address table</h3><table class="dt-ports" aria-label=${`MAC address table on ${name}`}><thead><tr><th scope="col">MAC</th><th scope="col">Port</th><th scope="col">Machine</th><th scope="col">Seen</th></tr></thead>
			<tbody>${entries.map(
				(e) =>
					html`<tr><td>${e.mac}</td><td>${e.port}</td><td class="dt-wrap">${e.label || "—"}</td><td data-state=${e.flushed ? "cut" : nothing}>${macSeen(e)}</td></tr>`,
			)}</tbody></table>
			${entries.length === 0 ? html`<p>Nothing learned yet.</p>` : nothing}`;
	}
}

customElements.define("unlab-mac-table", UnlabMacTable);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-mac-table": UnlabMacTable;
	}
}
