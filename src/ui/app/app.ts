import "../styles/index.css";
import "./app.css";
import "../pane-area/pane-area.ts";
import "../parked-strip/parked-strip.ts";
import "../rail/rail.ts";
import "../statusline/statusline.ts";
import { ContextProvider } from "@lit/context";
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { selectAgentIndicator, type UiEvent } from "../../model/index.ts";
import { Select, servicesContext } from "../base/index.ts";
import type { AppServices } from "../services.ts";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = MAC ? { label: "⌘K", aria: "Meta+K" } : { label: "Ctrl+/", aria: "Control+/" };
const ANNOUNCER = "unlab-announcer";
const AGENT_PANEL = "unlab-agent-panel";

/**
 * The shell: top bar, body and status line, with the services every element
 * below reads. Set `services` before adding it to the document.
 *
 * A view is a display mode, not a navigation: the lab body stays mounted and
 * is hidden under the other views, so panes and terminals never move.
 */
export class UnlabApp extends LitElement {
	static override properties = { services: { attribute: false } };
	declare services: AppServices | undefined;

	readonly #provider = new ContextProvider(this, { context: servicesContext });
	readonly #view = new Select(this, (state) => state.view);
	readonly #agentPanel = new Select(this, (state) => state.agentPanel);
	readonly #indicator = new Select(this, selectAgentIndicator);

	get app(): AppServices {
		if (!this.services) throw new Error("<unlab-app> needs its services before it connects");
		return this.services;
	}

	/** Says `text` through the app's one polite live region. */
	announce(text: string): void {
		const region = this.querySelector(`#${ANNOUNCER}`);
		if (!region) return;
		// A repeat of the same words is still a new announcement, so make the text differ.
		region.textContent = region.textContent === text ? `${text} ` : text;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("keydown", this.#onKeydown);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this.#onKeydown);
	}

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		if (changed.has("services") && this.services) this.#provider.setValue(this.services);
	}

	override render(): TemplateResult {
		const view = this.#view.value;
		const indicator = this.#indicator.value;
		const agentPanel = this.#agentPanel.value;
		return html`<header class="top-bar">
				<button type="button" class="wordmark" aria-label="unlab, back to the lab" @click=${() => this.#ui({ type: "ui/view", view: "lab" })}>
					unlab
				</button>
				<span class="lab-name">scratch</span>
				<div class="command-field">
					<span class="prompt" aria-hidden="true">:</span>
					<input type="text" aria-label="Command" aria-keyshortcuts=${SHORTCUT.aria} placeholder="spawn 2 alpine --net switch0" />
					<kbd>${SHORTCUT.label}</kbd>
				</div>
				<span class="spacer"></span>
				<button
					type="button"
					class="agent-indicator"
					data-state=${indicator}
					aria-expanded=${agentPanel ? "true" : "false"}
					aria-controls=${AGENT_PANEL}
					@click=${() => this.#ui({ type: "ui/agent-panel", open: !agentPanel })}
				>
					${indicator === "agent active" ? html`<span class="square" aria-hidden="true"></span>` : nothing}${indicator}
				</button>
				<button type="button" class="button primary" @click=${() => this.#ui({ type: "ui/view", view: "spawn" })}>
					Add machine
				</button>
			</header>
			<div class="body" ?hidden=${view === "spawn"}>
				<div class="lab" ?hidden=${view !== "lab"}>
					<unlab-rail role="complementary" aria-label="Machines"></unlab-rail>
					<main class="centre">
						<unlab-pane-area></unlab-pane-area>
						<unlab-parked-strip></unlab-parked-strip>
						<div class="dock"></div>
					</main>
				</div>
				<main class="wire-view" ?hidden=${view !== "wire"}></main>
				<div id=${AGENT_PANEL} class="agent-panel" ?hidden=${!agentPanel}></div>
			</div>
			<main class="spawn-view" ?hidden=${view !== "spawn"}></main>
			<unlab-statusline role="contentinfo"></unlab-statusline>
			<div id=${ANNOUNCER} class="visually-hidden" role="status"></div>`;
	}

	#ui(event: UiEvent): void {
		this.app.store.dispatchUi(event);
	}

	/** Esc leaves another view, then closes the agent panel. A terminal keeps its own Esc. */
	readonly #onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		if (event.target instanceof Node && this.querySelector("unlab-pane-area")?.contains(event.target)) return;
		const { view, agentPanel } = this.app.store.state;
		if (view !== "lab") this.#ui({ type: "ui/view", view: "lab" });
		else if (agentPanel) this.#ui({ type: "ui/agent-panel", open: false });
		else return;
		event.preventDefault();
	};
}

customElements.define("unlab-app", UnlabApp);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-app": UnlabApp;
	}
}
