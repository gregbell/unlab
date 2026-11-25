import { html, type TemplateResult } from "lit";
import { maximiseIcon, parkIcon, restoreIcon } from "./icons.ts";

/** Maximise and park, at the right of the header of every machine pane and every panel. */
export function windowButtons(
	name: string,
	maximised: boolean,
	on: { readonly maximise: () => void; readonly park: () => void },
): TemplateResult {
	return html`<button
			type="button"
			class="icon"
			aria-label="Maximise ${name}"
			aria-pressed=${maximised ? "true" : "false"}
			title=${maximised ? "Restore" : "Maximise"}
			@click=${on.maximise}
		>
			${maximised ? restoreIcon : maximiseIcon}
		</button>
		<button type="button" class="icon" aria-label="Park ${name}" title="Park" @click=${on.park}>${parkIcon}</button>`;
}
