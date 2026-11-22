import type { ReactiveController } from "lit";
import type { CaptureView } from "../../capture/index.ts";
import type { SelectHost } from "../base/index.ts";

/**
 * The capture's binding, as `Select` is the store's. Frames never enter the
 * store, so an element reads the capture while it renders, and this asks for
 * a render only when `key` changes: `(capture) => capture.revision` for a
 * list. The capture notifies at most once per animation frame, so neither
 * does this.
 */
export class FollowCapture<T> implements ReactiveController {
	readonly #host: SelectHost;
	readonly #key: (capture: CaptureView) => T;
	#unsubscribe: (() => void) | null = null;
	#last: T | undefined;

	constructor(host: SelectHost, key: (capture: CaptureView) => T) {
		this.#host = host;
		this.#key = key;
		host.addController(this);
	}

	hostConnected(): void {
		const { capture } = this.#host.app;
		this.#last = this.#key(capture);
		this.#unsubscribe = capture.subscribe(() => {
			const next = this.#key(capture);
			if (Object.is(next, this.#last)) return;
			this.#last = next;
			this.#host.requestUpdate();
		});
	}

	/** The key can read the host's other state, so what was rendered is the baseline to compare against. */
	hostUpdated(): void {
		this.#last = this.#key(this.#host.app.capture);
	}

	hostDisconnected(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
	}
}
