import "./cli-link.css";
import { html, type TemplateResult } from "lit";
import { type CliLink, selectCliSegment } from "../../model/index.ts";
import { closeIcon, Select, UnlabElement } from "../base/index.ts";

const TITLE_ID = "unlab-cli-link-title";
export const CLI_COMMAND = "npx unlab.run";

/** The status line's `cli: linked`, and what it opens: what the link is, and its switch. */
export class UnlabCliLink extends UnlabElement {
	readonly #cli = new Select(this, (s) => s.cli);
	readonly #segment = new Select(this, selectCliSegment);
	/** The newest call that waits for a yes. Its approval is in the agent panel, which an open dialog makes inert. */
	readonly #waiting = new Select(this, (s) => s.agent.calls.findLast((call) => call.status === "waiting")?.id ?? null);
	#lastWaiting: number | null = null;

	get #dialog(): HTMLDialogElement | null {
		return this.querySelector("dialog");
	}

	override updated(): void {
		const waiting = this.#waiting.value;
		if (waiting !== null && waiting !== this.#lastWaiting) this.#dialog?.close();
		this.#lastWaiting = waiting;
	}

	/** The dialog's content fills it, so a press on the dialog itself is on its backdrop. */
	readonly #onPointerDown = (event: PointerEvent): void => {
		if (event.target === this.#dialog) this.#dialog?.close();
	};

	override render(): TemplateResult {
		const { text, tone } = this.#segment.value;
		const on = this.#cli.value.kind !== "off";
		return html`<button type="button" class="segment opener" data-key="cli" data-tone=${tone} aria-haspopup="dialog"
				@click=${() => this.#dialog?.showModal()}>${text}</button>
			<dialog aria-labelledby=${TITLE_ID} @pointerdown=${this.#onPointerDown}>
				<div class="sheet">
					<div class="head">
						<h2 id=${TITLE_ID}>Reach the lab from your terminal</h2>
						<button type="button" class="icon" aria-label="Close" title="Close" @click=${() => this.#dialog?.close()}>
							${closeIcon}
						</button>
					</div>
					<div class="body">
						<p class="said">${said(this.#cli.value)}</p>
						<code>${CLI_COMMAND}</code>
						<p class="note">
							It gives you <code>ssh node1</code> into any machine, every lab command, and the internet for machines that
							have a gateway, through this computer. The lab tries to reach it only while the link is on.
						</p>
						<button type="button" class="switch" @click=${() => this.app.link.set(!on)}>
							${on ? "Turn the link off" : "Turn the link on"}
						</button>
					</div>
				</div>
			</dialog>`;
	}
}

function said(cli: CliLink): string {
	switch (cli.kind) {
		case "off":
			return "The link is off. Run the CLI in a terminal on this computer, and it opens the lab and links to it:";
		case "waiting":
			return "Waiting for the CLI. Run it in a terminal on this computer, and allow the lab to reach apps on this device if your browser asks:";
		case "blocked":
			return "Your browser does not let the lab reach apps on this device. Select the icon left of the address, allow it there, and reload. Then run:";
		case "linked":
			return "Linked to the CLI on this computer. It was started with:";
		case "refused":
			return cli.message;
	}
}

customElements.define("unlab-cli-link", UnlabCliLink);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-cli-link": UnlabCliLink;
	}
}
