import "./whats-new.css";
import { html, nothing, type TemplateResult } from "lit";
import { UnlabElement } from "../base/index.ts";
import { REPO_URL } from "../links.ts";
import { markSeen, unseenUpdates } from "./seen.ts";
import { UPDATES, type Update } from "./updates.ts";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** `[["2026-11-25", [...]], ...]`, in the order given. */
const byDate = (updates: readonly Update[]): readonly [string, readonly Update[]][] => [
	...Map.groupBy(updates, (update) => update.date),
];

/** `What’s new` in About unLAB, with a dot while there is an update this browser has not been shown, and the list it opens. */
export class UnlabWhatsNew extends UnlabElement {
	#dot = unseenUpdates() !== 0;
	/** How many rows the open list marks as new. None for a first visit: there, all of them would be. */
	#fresh = 0;

	#open(): void {
		this.#fresh = unseenUpdates() ?? 0;
		markSeen();
		this.#dot = false;
		this.requestUpdate();
	}

	#list() {
		return byDate(UPDATES).map(
			([date, updates]) => html`<section>
								<h3><time datetime=${date}>${day.format(new Date(date))}</time></h3>
								<ul role="list">${updates.map((update) => this.#row(update))}</ul>
							</section>`,
		);
	}
	override render(): TemplateResult {
		return html`<details @toggle=${(e: Event) => {
			if (e.currentTarget instanceof HTMLDetailsElement && e.currentTarget.open) this.#open();
		}}>
			<summary>What’s new${this.#dot ? html` <span class="dot"></span>` : nothing}</summary>${this.#list()}
			<a href="${REPO_URL}/commits/main" target="_blank" rel="noopener noreferrer">Every change on GitHub</a></details>`;
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
