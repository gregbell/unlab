import "../styles/index.css";
import "./app.css";
import "../command-bar/command-bar.ts";
import "../pane-area/pane-area.ts";
import "../parked-strip/parked-strip.ts";
import "../rail/rail.ts";
import "../statusline/statusline.ts";
import "../capture/capture.ts";
import "../switch/switch.ts";
import "../spawn-form/spawn-form.ts";
import { ContextProvider } from "@lit/context";
import { html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
	DEFAULT_SWITCH,
	type PanelName,
	parkedPanels,
	selectTiling,
	type UiEvent,
	visiblePanels,
} from "../../model/index.ts";
import { AGENT_PANEL_ID } from "../agent-panel/agent-panel.ts";
import { modalOpen, plusIcon, Select, servicesContext } from "../base/index.ts";
import type { AppServices } from "../services.ts";

const ANNOUNCER = "unlab-announcer";
const DOCK_ID = "unlab-dock";

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
	readonly #empty = new Select(this, (state) => state.rail.length === 0);
	readonly #panels = new Select(this, (state) => state.panels);
	readonly #tiling = new Select(this, selectTiling);
	/** The panel that had the focus before this render, in the dock or by its name in the bar. */
	#focused: { readonly panel: PanelName; readonly at: "dock" | "bar" } | null = null;

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
		const focused = document.activeElement;
		const panel = focused?.closest<HTMLElement>("[data-panel]")?.dataset.panel as PanelName | undefined;
		this.#focused = panel ? { panel, at: focused?.closest(`#${DOCK_ID}`) ? "dock" : "bar" } : null;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const from = this.#focused;
		this.#focused = null;
		if (!from) return;
		const parked = parkedPanels(this.#panels.value).includes(from.panel);
		if (parked === (from.at === "dock")) void this.#followPanel(from.panel, parked);
	}

	/**
	 * The button that parked a panel, or brought it back, goes with the press.
	 * The focus moves to the one that undoes it, once that is drawn.
	 */
	async #followPanel(panel: PanelName, parked: boolean): Promise<void> {
		if (parked) await this.querySelector("unlab-statusline")?.updateComplete;
		const place = parked ? "unlab-panel-bar" : `#${DOCK_ID} > [data-panel="${panel}"]`;
		const host = this.querySelector<LitElement>(place);
		await host?.updateComplete;
		host?.querySelector<HTMLElement>(parked ? `[data-panel="${panel}"]` : `[aria-label="Park ${panel}"]`)?.focus();
	}

	override render(): TemplateResult {
		const view = this.#view.value;
		const agentPanel = this.#agentPanel.value;
		const empty = this.#empty.value;
		const creating = view === "spawn" || (empty && view === "lab");
		const { columns, dockDivider } = this.#tiling.value;
		const { maximised } = this.#panels.value;
		const panels = visiblePanels(this.#panels.value);
		return html`<header class="top-bar">
				<button type="button" class="wordmark" aria-label="unLAB, back to the lab" @click=${() => this.#ui({ type: "ui/view", view: "lab" })}>
					un<span>LAB</span>
				</button>
				<unlab-command-bar></unlab-command-bar>
				<button ?hidden=${creating} type="button" class="button add-machines" aria-label="Add machines" @click=${() => this.#ui({ type: "ui/view", view: "spawn" })}>
					${plusIcon} Machines
				</button>
			</header>
			<div class="body">
				${creating ? html`<main class="spawn-view"><unlab-spawn-form></unlab-spawn-form></main>` : nothing}
				<div class="lab" ?hidden=${view !== "lab" || empty}>
					<unlab-rail role="complementary" aria-label="Machines"></unlab-rail>
					<main class="centre">
						<div class="panes" ?hidden=${empty || maximised !== null}>
							<unlab-pane-area></unlab-pane-area>
							<unlab-parked-strip></unlab-parked-strip>
						</div>
						<div id=${DOCK_ID} class="dock" ?data-maximised=${maximised !== null} ?hidden=${empty || panels.length === 0}
							style=${dockDivider ? `--dock-columns: ${columns}; --dock-divider: ${dockDivider}` : nothing}>
							${panels.includes("capture") ? html`<unlab-capture data-panel="capture" mode=${maximised ? "full" : "dock"}></unlab-capture>` : nothing}
							${panels.includes(DEFAULT_SWITCH) ? html`<unlab-switch data-panel=${DEFAULT_SWITCH} ?compact=${!maximised}></unlab-switch>` : nothing}
						</div>
					</main>
				</div>
				<div id=${AGENT_PANEL_ID} class="agent-panel" role="complementary" aria-label="Agent" ?hidden=${!agentPanel}>
					${agentPanel ? html`<unlab-agent-panel></unlab-agent-panel>` : nothing}
				</div>
			</div>
			<unlab-statusline role="contentinfo"></unlab-statusline>
			<div id=${ANNOUNCER} class="visually-hidden" role="status"></div>`;
	}

	#ui(event: UiEvent): void {
		this.app.store.dispatchUi(event);
	}

	/** Esc leaves another view, then restores a maximised panel, then closes the agent panel. A terminal keeps its own Esc. */
	readonly #onKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Escape" || event.defaultPrevented || modalOpen()) return;
		if (event.target instanceof Node && this.querySelector("unlab-pane-area")?.contains(event.target)) return;
		const { view, agentPanel, panels } = this.app.store.state;
		if (view !== "lab") this.#ui({ type: "ui/view", view: "lab" });
		else if (panels.maximised) this.#ui({ type: "ui/panel-maximised", panel: panels.maximised });
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
