import "./statusline.css";
import { html, type TemplateResult } from "lit";
import { type StatusSegment, selectStatus } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

const segment = (part: StatusSegment): TemplateResult =>
	html`<span class="segment" data-key=${part.key} data-tone=${part.tone}>${part.text}</span>`;

/** Counts for machines, sessions, links and WebMCP. Grey while all is well; red or yellow only while something is wrong or waiting. */
export class UnlabStatusline extends UnlabElement {
	readonly #status = new Select(this, selectStatus);

	override render(): TemplateResult {
		const { left, right } = this.#status.value;
		return html`${left.map(segment)}<span class="spacer"></span>${right.map(segment)}`;
	}
}

customElements.define("unlab-statusline", UnlabStatusline);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-statusline": UnlabStatusline;
	}
}
