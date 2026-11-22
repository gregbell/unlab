import "./wire.css";
import "../capture/capture.ts";
import "../switch/switch.ts";
import "./mac-table.ts";
import { html, type TemplateResult } from "lit";
import { UnlabElement } from "../base/index.ts";

/** The Wire view: the full-size faceplate and the MAC table, then the whole capture with the frame detail. */
export class UnlabWire extends UnlabElement {
	override render(): TemplateResult {
		return html`<div class="top">
				<unlab-switch></unlab-switch>
				<unlab-mac-table></unlab-mac-table>
			</div>
			<unlab-capture mode="full"></unlab-capture>`;
	}
}

customElements.define("unlab-wire", UnlabWire);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-wire": UnlabWire;
	}
}
