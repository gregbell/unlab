import "./machine-row.css";
import { html, nothing, type TemplateResult } from "lit";
import type { RailRow } from "../../model/index.ts";
import { UnlabElement } from "../base/index.ts";

type Tone = "ok" | "down" | "busy" | "quiet";

/** State has a word; colour only reinforces it. */
function toneOf(word: RailRow["word"]): Tone {
	switch (word) {
		case "up":
			return "ok";
		case "cut":
		case "failed":
			return "down";
		case "unplugged":
		case "off":
		case "removing":
			return "quiet";
		default:
			return "busy";
	}
}

/**
 * One rail row: a 3px bar, the name in its hue, a second line and the state
 * word. The whole row is one button that gives the machine the keyboard.
 */
export class UnlabMachineRow extends UnlabElement {
	static override properties = { row: { attribute: false } };
	declare row: RailRow | undefined;

	override render(): TemplateResult | typeof nothing {
		const { row } = this;
		if (!row) return nothing;
		return html`<button
			type="button"
			class="row"
			data-hue=${row.hue}
			data-phase=${row.phase}
			aria-current=${row.focused ? "true" : nothing}
			?disabled=${row.phase === "removing"}
			@click=${() => this.runLine(`focus ${row.name}`)}
		>
			<span class="lines">
				<span class="name" title=${row.name}>${row.name}</span>
				<span class="line2">${row.line2}</span>
			</span>
			<span class="word" data-tone=${toneOf(row.word)}>${row.word}</span>
		</button>`;
	}
}

customElements.define("unlab-machine-row", UnlabMachineRow);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-machine-row": UnlabMachineRow;
	}
}
