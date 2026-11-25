import "./panel-bar.css";
import { html, nothing, type TemplateResult } from "lit";
import { PANELS, type PanelName, selectLinks, visiblePanels } from "../../model/index.ts";
import { downIcon, Select, UnlabElement, upIcon } from "../base/index.ts";

/** The id of the app's dock, which the bar's buttons fill and empty. */
export const DOCK_ID = "unlab-dock";

/**
 * Every panel by name, with the one thing worth knowing while it is parked.
 * A name shows its panel or parks it, and the arrow does that for all of
 * them. The bar never moves, whatever is open.
 */
export class UnlabPanelBar extends UnlabElement {
	readonly #panels = new Select(this, (s) => s.panels);
	readonly #paused = new Select(this, (s) => s.capture.paused);
	readonly #links = new Select(this, selectLinks);

	override render(): TemplateResult {
		const panels = this.#panels.value;
		const open = panels.open.length > 0;
		const visible = visiblePanels(panels);
		return html`<button
				type="button"
				class="all"
				aria-label="All panels"
				aria-controls=${DOCK_ID}
				aria-expanded=${String(open)}
				title=${open ? "Park all panels" : "Bring back the panels"}
				@click=${() => this.app.store.dispatchUi({ type: "ui/panels", open: !open })}
			>
				${open ? downIcon : upIcon}
			</button>
			${PANELS.map(
				(name) => html`<button
					type="button"
					class="panel"
					data-panel=${name}
					aria-pressed=${String(visible.includes(name))}
					@click=${() => this.app.store.dispatchUi({ type: "ui/panel-toggled", panel: name })}
				>
					${name} ${this.#word(name)}
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
