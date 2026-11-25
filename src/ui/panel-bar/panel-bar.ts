import "./panel-bar.css";
import { html, nothing, type TemplateResult } from "lit";
import { type PanelName, panelLabel, parkedPanels, selectAllLinks } from "../../model/index.ts";
import { Select, UnlabElement, upIcon } from "../base/index.ts";

/** The parked panels by name, each with the one thing worth knowing while it is away. A click brings it back. */
export class UnlabPanelBar extends UnlabElement {
	readonly #panels = new Select(this, (s) => s.panels);
	readonly #paused = new Select(this, (s) => s.capture.paused);
	readonly #switches = new Select(this, (s) => s.switches);
	readonly #links = new Select(this, selectAllLinks);

	override render(): TemplateResult {
		const label = (name: PanelName) => panelLabel(name, { switches: this.#switches.value });
		return html`${parkedPanels(this.#panels.value).map(
			(name) => html`<button
				type="button"
				data-panel=${name}
				title="Bring back ${label(name)}"
				@click=${() => this.app.store.dispatchUi({ type: "ui/panel-unparked", panel: name })}
			>
				${upIcon} ${label(name)} ${this.#word(name)}
			</button>`,
		)}`;
	}

	#word(name: PanelName): TemplateResult | typeof nothing {
		if (name === "capture") {
			const paused = this.#paused.value;
			return html`<span class="word" data-tone=${paused ? "warn" : "ok"}>${paused ? "paused" : "live"}</span>`;
		}
		const { up, total, cut } = this.#links.value;
		if (total === 0) return nothing;
		return html`<span class="word" data-tone=${cut > 0 ? "down" : "quiet"}>${up} of ${total} up</span>`;
	}
}

customElements.define("unlab-panel-bar", UnlabPanelBar);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-panel-bar": UnlabPanelBar;
	}
}
