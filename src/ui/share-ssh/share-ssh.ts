import "./share-ssh.css";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import type { MachineName } from "../../model/index.ts";
import { UnlabElement } from "../base/index.ts";

/** A view of the guest's page-owned share. Closing the view does not stop it. */
export class UnlabShareSsh extends UnlabElement {
	static override properties = { machine: { attribute: false } };
	declare machine: MachineName;

	#expanded = false;
	#key = "";
	#copyError = "";
	#unsubscribe: (() => void) | null = null;
	#unsubscribeStore: (() => void) | null = null;

	override connectedCallback(): void {
		super.connectedCallback();
		this.#subscribe();
		this.#unsubscribeStore = this.app.store.subscribe(() => this.requestUpdate());
	}

	override disconnectedCallback(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		this.#unsubscribeStore?.();
		this.#unsubscribeStore = null;
		super.disconnectedCallback();
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		if (changed.has("machine")) {
			this.#key = "";
			this.#copyError = "";
			this.#expanded = false;
			this.#subscribe();
		}
		if (this.app.share.state(this.machine).kind !== "idle") this.#expanded = true;
	}

	#subscribe(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = this.app.share.subscribe(this.machine, () => this.requestUpdate());
	}

	readonly #start = (event: SubmitEvent): void => {
		event.preventDefault();
		const key = this.#key.trim();
		if (!key || this.app.store.state.machines[this.machine]?.life.phase !== "ready") return;
		this.app.share.start(this.machine, key);
	};

	readonly #copy = async (): Promise<void> => {
		const state = this.app.share.state(this.machine);
		if (state.kind !== "ready") return;
		try {
			await navigator.clipboard.writeText(state.command);
			this.#copyError = "";
		} catch {
			this.#copyError = "Could not copy. Select the command and copy it manually.";
		}
		this.requestUpdate();
	};

	override render(): TemplateResult {
		const ready = this.app.store.state.machines[this.machine]?.life.phase === "ready";
		const state = this.app.share.state(this.machine);
		return html`<section class="share" aria-label=${`Share ${this.machine} via SSH`}>
			${
				this.#expanded
					? html`<h3>Share via SSH</h3>
						<p>The key holder can sign in and administer ${this.machine}. Keep this tab open while sharing.</p>
						${
							state.kind === "starting"
								? html`<p role="status">Starting share…</p><button type="button" class="button" @click=${() => this.app.share.stop(this.machine)}>Cancel sharing</button>`
								: state.kind === "ready"
									? html`<p role="status">Share is active.</p>
										<code class="command">${state.command}</code>
										<div class="share-actions"><button type="button" class="button" @click=${this.#copy}>Copy command</button>
										<button type="button" class="button" @click=${() => this.app.share.stop(this.machine)}>Stop sharing</button></div>
										${this.#copyError ? html`<p class="error" role="alert">${this.#copyError}</p>` : nothing}`
									: html`<form @submit=${this.#start}>
										<label for=${`share-ssh-key-${this.machine}`}>Their SSH public key</label>
										<textarea id=${`share-ssh-key-${this.machine}`} rows="3" spellcheck="false" autocomplete="off"
											placeholder="ssh-ed25519 AAAA…" .value=${this.#key}
											@input=${(event: Event) => {
												if (event.target instanceof HTMLTextAreaElement) {
													this.#key = event.target.value;
													this.requestUpdate();
												}
											}}></textarea>
										${state.kind === "failed" ? html`<p class="error" role="alert">${state.reason}</p>` : nothing}
										<button type="submit" class="button" ?disabled=${!ready || !this.#key.trim()}>Start sharing</button>
									</form>`
						}`
					: html`<button type="button" class="button" ?disabled=${!ready} @click=${() => {
							this.#expanded = true;
							this.requestUpdate();
						}}>Share via SSH</button>`
			}
		</section>`;
	}
}

customElements.define("unlab-share-ssh", UnlabShareSsh);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-share-ssh": UnlabShareSsh;
	}
}
