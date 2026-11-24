import "./parked-strip.css";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { selectParkedChips } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

const NOTE = "parked-strip-note";

/** One chip per parked pane, in pane order. Absent while nothing is parked. */
export class UnlabParkedStrip extends UnlabElement {
	readonly #chips = new Select(this, selectParkedChips);
	readonly #machines = new Select(this, (s) => s.machines);

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		this.hidden = this.#chips.value.length === 0;
	}

	override render(): TemplateResult | typeof nothing {
		const chips = this.#chips.value;
		if (chips.length === 0) return nothing;
		const machines = this.#machines.value;
		return html`<span class="label" id="parked-strip-label">parked</span>
			<ul class="chips" role="list" aria-labelledby="parked-strip-label">
				${repeat(
					chips,
					(name) => name,
					(name) => html`<li>
						<button
							type="button"
							class="chip"
							title=${name}
							data-hue=${machines[name]?.hue ?? nothing}
							aria-describedby=${NOTE}
							@click=${() => this.app.store.dispatchUi({ type: "ui/unpark", machine: name })}
						>
							${name}
						</button>
					</li>`,
				)}
			</ul>
			<span class="fill"></span>
			<span class="note" id=${NOTE}>Still running. Click to bring it back.</span>`;
	}
}

customElements.define("unlab-parked-strip", UnlabParkedStrip);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-parked-strip": UnlabParkedStrip;
	}
}
