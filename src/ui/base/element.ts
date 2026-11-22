import { ContextConsumer } from "@lit/context";
import { LitElement } from "lit";
import type { AppServices } from "../services.ts";
import { servicesContext } from "./context.ts";

/**
 * Every element but <unlab-app> extends this. Light DOM, so ARIA IDREFs and the
 * one live region work across the whole app and one cascade styles it all.
 * Properties are `static properties` with `declare` fields: an initialised
 * class field would shadow Lit's accessor and the element would never update.
 */
export abstract class UnlabElement extends LitElement {
	// The provider is an ancestor, so the value arrives while this element
	// connects, before any Select reads the store.
	readonly #services = new ContextConsumer(this, { context: servicesContext });

	get app(): AppServices {
		const services = this.#services.value;
		if (!services) throw new Error(`<${this.localName}> needs <unlab-app> or a services provider above it`);
		return services;
	}

	protected override createRenderRoot(): HTMLElement {
		return this;
	}

	/** Every lab change a control makes is a command line, run as a button. */
	protected runLine(line: string): void {
		this.app.commands.run(line, "button").catch((error: unknown) => {
			console.error(`${line} failed`, error);
		});
	}
}
