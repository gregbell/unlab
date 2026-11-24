import "./pane-area.css";
import "../pane/pane.ts";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { selectTiling } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

/**
 * The pane area: one pane per machine, in creation order, laid out on one CSS
 * grid. Tiling only changes which grid area each pane takes and which are
 * hidden, so a pane and its terminals never move in the DOM.
 *
 * It reports its own size, which is what decides how many panes fit.
 */
export class UnlabPaneArea extends UnlabElement {
	readonly #machines = new Select(this, (s) => s.rail);
	readonly #tiling = new Select(this, selectTiling);
	#observer: ResizeObserver | null = null;
	#resizeFrame = 0;
	#reported: { readonly width: number; readonly height: number } | null = null;

	override connectedCallback(): void {
		super.connectedCallback();
		this.#observer = new ResizeObserver(([entry]) => {
			// Retiling also changes the dock width split and can resize this area again.
			if (entry) {
				cancelAnimationFrame(this.#resizeFrame);
				this.#resizeFrame = requestAnimationFrame(() => this.#resized(entry.contentRect));
			}
		});
		this.#observer.observe(this);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.#observer?.disconnect();
		cancelAnimationFrame(this.#resizeFrame);
		this.#observer = null;
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		const { columns, rows } = this.#tiling.value;
		this.style.gridTemplateColumns = columns;
		this.style.gridTemplateRows = rows;
	}

	override render(): TemplateResult {
		const areas = new Map(this.#tiling.value.tiles.map((tile) => [tile.machine, tile.area]));
		return html`${repeat(
			this.#machines.value,
			(machine) => machine,
			(machine) => {
				const area = areas.get(machine);
				return html`<unlab-pane machine=${machine} style=${area ? `grid-area: ${area}` : ""} ?hidden=${!area}></unlab-pane>`;
			},
		)}`;
	}

	/** A hidden area measures zero; that is not a size to tile for, or every pane but one would park. */
	#resized({ width, height }: DOMRectReadOnly): void {
		const size = { width: Math.round(width), height: Math.round(height) };
		if (size.width === 0 || size.height === 0) return;
		if (this.#reported?.width === size.width && this.#reported.height === size.height) return;
		this.#reported = size;
		this.app.store.dispatchUi({ type: "ui/area-resized", ...size });
	}
}

customElements.define("unlab-pane-area", UnlabPaneArea);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-pane-area": UnlabPaneArea;
	}
}
