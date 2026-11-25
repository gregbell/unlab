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
import { type PanelName, selectTiling, type UiEvent, visiblePanels } from "../../model/index.ts";
import { AGENT_PANEL_ID } from "../agent-panel/agent-panel.ts";
import { plusIcon, Select, servicesContext } from "../base/index.ts";
import { DOCK_ID } from "../panel-bar/panel-bar.ts";
import type { AppServices } from "../services.ts";

const ANNOUNCER = "unlab-announcer";

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
	/** The panel that had the focus before this render, which may park it. */
	#focusedPanel: PanelName | null = null;

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
		const focused = document.activeElement?.closest(`#${DOCK_ID} > unlab-capture, #${DOCK_ID} > unlab-switch`);
		this.#focusedPanel = focused ? (focused.localName === "unlab-capture" ? "capture" : "switch0") : null;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const panel = this.#focusedPanel;
		this.#focusedPanel = null;
		// Its button went with it, so its name in the bar takes the focus: that is the way back.
		if (panel && !visiblePanels(this.#panels.value).includes(panel))
			this.querySelector<HTMLElement>(`unlab-panel-bar [data-panel="${panel}"]`)?.focus();
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
							${panels.includes("capture") ? html`<unlab-capture mode=${maximised ? "full" : "dock"}></unlab-capture>` : nothing}
							${panels.includes("switch0") ? html`<unlab-switch ?compact=${!maximised}></unlab-switch>` : nothing}
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
		if (event.key !== "Escape" || event.defaultPrevented) return;
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
