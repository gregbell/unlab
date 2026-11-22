import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { LabState } from "../../model/index.ts";
import type { AppServices } from "../services.ts";

export type SelectHost = ReactiveControllerHost & { readonly app: AppServices };

/**
 * The one store binding: `readonly #rows = new Select(this, selectRail)` in a
 * field. It subscribes while the host is connected and asks for a render only
 * when the selected value changes by `Object.is`. Model selectors are
 * memoised, so a derived list keeps its identity until its inputs change.
 */
export class Select<T> implements ReactiveController {
	readonly #host: SelectHost;
	readonly #selector: (state: LabState) => T;
	#current: { value: T } | null = null;
	#unsubscribe: (() => void) | null = null;

	constructor(host: SelectHost, selector: (state: LabState) => T) {
		this.#host = host;
		this.#selector = selector;
		host.addController(this);
	}

	get value(): T {
		if (!this.#current) throw new Error("Select: read before its host connected");
		return this.#current.value;
	}

	hostConnected(): void {
		const { store } = this.#host.app;
		const current = { value: this.#selector(store.state) };
		this.#current = current;
		this.#unsubscribe = store.subscribe(() => {
			const next = this.#selector(store.state);
			if (Object.is(next, current.value)) return;
			current.value = next;
			this.#host.requestUpdate();
		});
	}

	hostDisconnected(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}
}
