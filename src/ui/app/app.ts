import "../styles/index.css";
import "./app.css";
import "../desktop/desktop.ts";
import { ContextProvider } from "@lit/context";
import { html, LitElement, type PropertyValues, type TemplateResult } from "lit";
import { servicesContext } from "../base/index.ts";
import type { AppServices } from "../services.ts";

const ANNOUNCER = "unlab-announcer";

/** The shell: the desktop, with the services every element below reads. Set `services` before adding it to the document. */
export class UnlabApp extends LitElement {
	static override properties = { services: { attribute: false } };
	declare services: AppServices | undefined;

	readonly #provider = new ContextProvider(this, { context: servicesContext });

	/** Says `text` through the app's one polite live region. */
	announce(text: string): void {
		const region = this.querySelector(`#${ANNOUNCER}`);
		if (!region) return;
		// A repeat of the same words is still a new announcement, so make the text differ.
		region.textContent = region.textContent === text ? `${text} ` : text;
	}

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		if (changed.has("services") && this.services) this.#provider.setValue(this.services);
	}

	override render(): TemplateResult {
		return html`<unlab-desktop></unlab-desktop><div id=${ANNOUNCER} class="visually-hidden" role="status"></div>`;
	}
}

customElements.define("unlab-app", UnlabApp);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-app": UnlabApp;
	}
}
