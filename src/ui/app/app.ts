import "../styles/index.css";
import "./app.css";
import "../command-bar/command-bar.ts";
import "../pane-area/pane-area.ts";
import "../parked-strip/parked-strip.ts";
import "../rail/rail.ts";
import "../statusline/statusline.ts";
import "../capture/capture.ts";
import "../switch/switch.ts";
import "../wire/wire.ts";
import "../start/start.ts";
import "../spawn-form/spawn-form.ts";
import "../agent-panel/agent-panel.ts";
import { ContextProvider } from "@lit/context";
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { type Dock, SWITCH_NAME, selectAgentIndicator, selectLinks, type UiEvent } from "../../model/index.ts";
import { Select, servicesContext } from "../base/index.ts";
import { DOCK_ID } from "../capture/capture.ts";
import type { AppServices } from "../services.ts";

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
	readonly #empty = new Select(this, (state) => state.rail.length === 0);
	readonly #dock = new Select(this, (state) => state.dock);
	readonly #paused = new Select(this, (state) => state.capture.paused);
	readonly #links = new Select(this, selectLinks);
	#shownDock: Dock | null = null;
	#refocusDock = false;

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
		const dock = this.#dock.value;
		if (this.#shownDock !== null && dock !== this.#shownDock)
			this.#refocusDock = this.querySelector(`#${DOCK_ID}`)?.contains(document.activeElement) ?? false;
		this.#shownDock = dock;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		if (!this.#refocusDock) return;
		this.#refocusDock = false;
		void this.#focusDockToggle();
	}

	override render(): TemplateResult {
		const view = this.#view.value;
		const indicator = this.#indicator.value;
		const agentPanel = this.#agentPanel.value;
		const empty = this.#empty.value;
		return html`<header class="top-bar">
				<button type="button" class="wordmark" aria-label="unlab, back to the lab" @click=${() => this.#ui({ type: "ui/view", view: "lab" })}>
					unlab
				</button>
				<span class="lab-name">scratch</span>
				<unlab-command-bar></unlab-command-bar>
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
						<unlab-start ?hidden=${!empty}></unlab-start>
						<unlab-pane-area ?hidden=${empty}></unlab-pane-area>
						<unlab-parked-strip></unlab-parked-strip>
						<div id=${DOCK_ID} class="dock" ?hidden=${empty}>
							${
								this.#dock.value === "open"
									? html`<unlab-capture mode="dock"></unlab-capture><unlab-switch compact></unlab-switch>`
									: this.#dockStrip()
							}
						</div>
					</main>
				</div>
				<main class="wire-view" ?hidden=${view !== "wire"}>${view === "wire" ? html`<unlab-wire></unlab-wire>` : nothing}</main>
				<div id=${AGENT_PANEL} class="agent-panel" role="complementary" aria-label="Agent" ?hidden=${!agentPanel}>
					${agentPanel ? html`<unlab-agent-panel></unlab-agent-panel>` : nothing}
				</div>
			</div>
			<main class="spawn-view" ?hidden=${view !== "spawn"}>${view === "spawn" ? html`<unlab-spawn-form></unlab-spawn-form>` : nothing}</main>
			<unlab-statusline role="contentinfo"></unlab-statusline>
			<div id=${ANNOUNCER} class="visually-hidden" role="status"></div>`;
	}

	/** The collapsed dock: whether the capture runs, how many links are up, and the way back. */
	#dockStrip(): TemplateResult {
		const paused = this.#paused.value;
		const links = this.#links.value;
		return html`<div class="dock-strip">
			<span class="title">network</span>
			<span class="status" data-paused=${paused}>${paused ? "paused" : "live"}</span>
			<span class="spacer"></span>
			<span class="links" data-cut=${links.cut > 0}>${SWITCH_NAME} · ${links.up} of ${links.total} links up</span>
			<button
				type="button"
				class="button"
				aria-expanded="false"
				aria-controls=${DOCK_ID}
				@click=${() => this.#ui({ type: "ui/dock", dock: "open" })}
			>
				show
			</button>
		</div>`;
	}

	/** The button that toggled the dock is gone; its counterpart takes the focus, once the capture has drawn its own. */
	async #focusDockToggle(): Promise<void> {
		const dock = this.querySelector(`#${DOCK_ID}`);
		await dock?.querySelector("unlab-capture")?.updateComplete;
		dock?.querySelector<HTMLElement>(`button[aria-controls="${DOCK_ID}"]`)?.focus();
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
