import "./statusline.css";
import "../panel-bar/panel-bar.ts";
import "../whats-new/whats-new.ts";
import { html, nothing, type TemplateResult } from "lit";
import { parkedPanels, type StatusSegment, selectStatus } from "../../model/index.ts";
import { AGENT_PANEL_ID } from "../agent-panel/agent-panel.ts";
import { githubMark, Select, UnlabElement, xMark } from "../base/index.ts";
import { AUTHOR_URL, REPO_URL, X_ACCOUNT, X_URL } from "../links.ts";

const segment = (part: StatusSegment): TemplateResult =>
	html`<span class="segment" data-key=${part.key} data-tone=${part.tone}>${part.text}</span>`;

/** Counts for machines and sessions, the panel bar while a panel is parked, WebMCP, what's new and who makes it. Grey while all is well; red or yellow only while something is wrong or waiting. */
export class UnlabStatusline extends UnlabElement {
	readonly #status = new Select(this, selectStatus);

	/** The other views, and an empty lab, have no panels under them. */
	readonly #panels = new Select(
		this,
		(state) => state.view === "lab" && state.rail.length > 0 && parkedPanels(state.panels).length > 0,
	);
	readonly #agentPanel = new Select(this, (state) => state.agentPanel);

	override render(): TemplateResult {
		const { left, right } = this.#status.value;
		return html`<div class="group counts">${left.map(segment)}</div>
			${this.#panels.value ? html`<unlab-panel-bar role="group" aria-label="Parked panels"></unlab-panel-bar>` : nothing}
			<div class="group end">${right.map((part) =>
				part.key === "webmcp"
					? html`<button type="button" class="segment agent-toggle" data-key=${part.key} data-tone=${part.tone}
				aria-controls=${AGENT_PANEL_ID} aria-expanded=${String(this.#agentPanel.value)}
				@click=${() => this.app.store.dispatchUi({ type: "ui/agent-panel", open: !this.#agentPanel.value })}>${part.text}</button>`
					: segment(part),
			)}
			<unlab-whats-new></unlab-whats-new>
			<span data-key="credit">Built by <a href=${AUTHOR_URL} target="_blank" rel="noopener noreferrer">Greg Bell</a> with <a href="https://unkernel.dev/" target="_blank" rel="noopener noreferrer">unkernel.dev</a></span>
			<span class="marks">
				<a href=${REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="unlab on GitHub" title="unlab on GitHub">${githubMark}</a>
				<a href=${X_URL} target="_blank" rel="noopener noreferrer" aria-label="${X_ACCOUNT} on X" title="${X_ACCOUNT} on X">${xMark}</a>
			</span></div>`;
	}
}

customElements.define("unlab-statusline", UnlabStatusline);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-statusline": UnlabStatusline;
	}
}
