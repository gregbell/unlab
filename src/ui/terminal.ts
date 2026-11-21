// Terminals, on libghostty.
//
// Each pane is a WTerm (DOM renderer, input, selection, accessibility) driven
// by GhosttyCore: Ghostty's own VT engine compiled to WebAssembly, so escape
// sequences, graphemes, wide glyphs and SGR behave as they do in Ghostty
// itself. One core per pane — a core holds a grid — but the WASM module is
// compiled once and shared across them.

import { WTerm } from "@wterm/dom";
import { GhosttyCore } from "@wterm/ghostty";
// Let the bundler emit the binary and hand us its real URL; left to resolve
// itself it can end up as a build-machine file: path.
import ghosttyWasmUrl from "@wterm/ghostty/ghostty-vt.wasm?url";
import type { Session } from "../lab/machine.ts";

export class TerminalPane {
	readonly session: Session;
	readonly element: HTMLDivElement;
	#term: WTerm | undefined;
	#unsubscribe: (() => void) | undefined;
	#destroyed = false;
	#active = false;

	constructor(session: Session) {
		this.session = session;
		this.element = document.createElement("div");
		this.element.className = "pane";
	}

	async mount(parent: HTMLElement, active: boolean): Promise<void> {
		parent.append(this.element);
		this.#active = active;
		this.element.classList.toggle("hidden", !active);

		const core = await GhosttyCore.load({ wasmPath: ghosttyWasmUrl, scrollbackLines: 5000 });
		if (this.#destroyed) return;

		const term = new WTerm(this.element, {
			core,
			cols: this.session.cols,
			rows: this.session.rows,
			autoResize: true,
			// An inactive pane keeps parsing output; only painting stops.
			renderingPaused: !active,
			onData: (data) => this.session.write(data),
			onResize: (cols, rows) => this.session.resize(cols, rows),
		});
		await term.init();
		if (this.#destroyed) {
			term.destroy();
			return;
		}
		this.#term = term;

		// Whatever the session printed before this pane existed.
		for (const chunk of this.session.scrollback) term.write(chunk);
		this.#unsubscribe = this.session.onData((bytes) => term.write(bytes));

		if (active) {
			term.fit();
			term.focus();
		}
	}

	setActive(active: boolean): void {
		this.#active = active;
		this.element.classList.toggle("hidden", !active);
		const term = this.#term;
		if (!term) return;
		term.setRenderingPaused(!active);
		if (!active) return;
		// The pane may have been hidden while the window changed size.
		requestAnimationFrame(() => {
			if (!this.#active || this.#destroyed) return;
			term.fit();
			term.focus();
		});
	}

	fit(): void {
		if (!this.#active) return;
		this.#term?.fit();
	}

	focus(): void {
		this.#term?.focus();
	}

	destroy(): void {
		this.#destroyed = true;
		this.#unsubscribe?.();
		this.#term?.destroy();
		this.#term = undefined;
		this.element.remove();
	}
}
