import "./whats-new.css";
import { html, nothing, type TemplateResult } from "lit";
import { closeIcon, Select, UnlabElement } from "../base/index.ts";
import { REPO_URL, X_ACCOUNT, X_URL } from "../links.ts";
import { markSeen, unseenUpdates } from "./seen.ts";
import { UPDATES, type Update } from "./updates.ts";

const TITLE_ID = "unlab-whats-new-title";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** `[["2026-11-25", [...]], ...]`, in the order given. */
const byDate = (updates: readonly Update[]): readonly [string, readonly Update[]][] => [
	...Map.groupBy(updates, (update) => update.date),
];

/** The status line's `What's new`, with a dot while there is an update this browser has not been shown, and the list it opens. */
export class UnlabWhatsNew extends UnlabElement {
	/** The newest call that waits for a yes. Its approval is in the agent panel, which an open dialog makes inert. */
	readonly #waiting = new Select(this, (s) => s.agent.calls.findLast((call) => call.status === "waiting")?.id ?? null);
	#lastWaiting: number | null = null;
	#dot = unseenUpdates() !== 0;
	/** How many rows the open dialog marks as new. None for a first visit: there, all of them would be. */
	#fresh = 0;

	get #dialog(): HTMLDialogElement | null {
		return this.querySelector("dialog");
	}

	override updated(): void {
		const waiting = this.#waiting.value;
		if (waiting !== null && waiting !== this.#lastWaiting) this.#dialog?.close();
		this.#lastWaiting = waiting;
	}

	#open(): void {
		this.#fresh = unseenUpdates() ?? 0;
		markSeen();
		this.#dot = false;
		this.requestUpdate();
		this.#dialog?.showModal();
	}

	/** The dialog's content fills it, so a press on the dialog itself is on its backdrop. */
	readonly #onPointerDown = (event: PointerEvent): void => {
		if (event.target === this.#dialog) this.#dialog?.close();
	};

	#list() {
		return byDate(UPDATES).map(
			([date, updates]) => html`<section>
								<h3><time datetime=${date}>${day.format(new Date(date))}</time></h3>
								<ul role="list">${updates.map((update) => this.#row(update))}</ul>
							</section>`,
		);
	}
	override render(): TemplateResult {
		if (this.hasAttribute("inline"))
			return html`<details @toggle=${(e: Event) => {
				if (e.currentTarget instanceof HTMLDetailsElement && e.currentTarget.open) this.#open();
			}}>
			<summary>What’s new${this.#dot ? html` <span class="dot"></span>` : nothing}</summary>${this.#list()}
			<a href="${REPO_URL}/commits/main" target="_blank" rel="noopener noreferrer">Every change on GitHub</a></details>`;
		return html`<button type="button" class="opener" aria-haspopup="dialog" @click=${() => this.#open()}>
				What’s new${this.#dot ? html`<span class="dot"></span><span class="visually-hidden">, not seen yet</span>` : nothing}
			</button>
			<dialog aria-labelledby=${TITLE_ID} @pointerdown=${this.#onPointerDown}>
				<div class="sheet">
					<div class="head">
						<h2 id=${TITLE_ID}>What’s new</h2>
						<button type="button" class="icon" aria-label="Close" title="Close" @click=${() => this.#dialog?.close()}>
							${closeIcon}
						</button>
					</div>
					<div class="scroll">
						${this.#list()}
					</div>
					<p class="foot">
						<a href="${REPO_URL}/commits/main" target="_blank" rel="noopener noreferrer">Every change on GitHub</a>
						<a href=${X_URL} target="_blank" rel="noopener noreferrer">Follow ${X_ACCOUNT} on X</a>
					</p>
				</div>
			</dialog>`;
	}

	#row(update: Update): TemplateResult {
		const { title, detail, example, pull } = update;
		const fresh = UPDATES.indexOf(update) < this.#fresh;
		return html`<li>
			<p class="title">
				${title}${fresh ? html` <span class="fresh">new</span>` : nothing}
				${
					pull
						? html`<a href="${REPO_URL}/pull/${pull}" target="_blank" rel="noopener noreferrer" aria-label="Pull request ${pull}">#${pull}</a>`
						: nothing
				}
			</p>
			<p class="detail">${detail}</p>
			${example ? html`<code>${example}</code>` : nothing}
		</li>`;
	}
}

customElements.define("unlab-whats-new", UnlabWhatsNew);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-whats-new": UnlabWhatsNew;
	}
}
