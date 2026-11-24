import "./statusline.css";
import { html, type TemplateResult } from "lit";
import { type StatusSegment, selectStatus } from "../../model/index.ts";
import { AGENT_PANEL_ID } from "../agent-panel/agent-panel.ts";
import { Select, UnlabElement } from "../base/index.ts";

const segment = (part: StatusSegment): TemplateResult =>
	html`<span class="segment" data-key=${part.key} data-tone=${part.tone}>${part.text}</span>`;

/** Counts for machines, sessions, links and WebMCP. Grey while all is well; red or yellow only while something is wrong or waiting. */
export class UnlabStatusline extends UnlabElement {
	readonly #status = new Select(this, selectStatus);

	readonly #agentPanel = new Select(this, (state) => state.agentPanel);

	override render(): TemplateResult {
		const { left, right } = this.#status.value;
		return html`<div class="group">${left.map(segment)}</div>
			<div class="group">${right.map((part) =>
				part.key === "webmcp"
					? html`<button type="button" class="segment agent-toggle" data-key=${part.key} data-tone=${part.tone}
				aria-controls=${AGENT_PANEL_ID} aria-expanded=${String(this.#agentPanel.value)}
				@click=${() => this.app.store.dispatchUi({ type: "ui/agent-panel", open: !this.#agentPanel.value })}>${part.text}</button>`
					: segment(part),
			)}
			<a href="https://github.com/gregbell/unlab" target="_blank" rel="noopener noreferrer">GitHub</a>
			<span data-key="engine">Built with <a href="https://unkernel.dev/" target="_blank" rel="noopener noreferrer">unkernel.dev</a></span></div>`;
	}
}

customElements.define("unlab-statusline", UnlabStatusline);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-statusline": UnlabStatusline;
	}
}
