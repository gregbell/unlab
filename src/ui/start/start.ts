import "./start.css";
import { html, nothing, type TemplateResult } from "lit";
import { isLineError, type LineError } from "../../commands/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

interface StartingPoint {
	readonly title: string;
	readonly about: string;
	readonly line: (image: string) => string;
}

const STARTING_POINTS: readonly StartingPoint[] = [
	{ title: "1 machine", about: "A shell and nothing else.", line: (image) => `spawn 1 ${image}` },
	{
		title: "2 on a switch",
		about: "Ping across and watch the frames.",
		line: (image) => `spawn 2 ${image} --net switch0`,
	},
	{
		title: "3 and a cut cable",
		about: "Take one off the network. See who notices.",
		line: (image) => `spawn 3 ${image} --net switch0`,
	},
];

/**
 * First run: what the lab shows in place of the panes and the dock while it
 * has no machines. A line typed here runs as if typed in the bar; a starting
 * point runs its line as a button.
 */
export class UnlabStart extends UnlabElement {
	static override properties = { error: { state: true } };
	declare error: LineError | null;

	readonly #images = new Select(this, (state) => state.images);
	readonly #policies = new Select(this, (state) => state.agent.policies);

	override render(): TemplateResult {
		const image = this.#images.value[0]?.name;
		const tools = Object.values(this.#policies.value).filter((policy) => policy !== "off").length;
		const error = this.error ?? null;
		return html`<div class="sheet">
			<div class="intro">
				<h1>Boot some Linux.</h1>
				<p class="lede">Boot Linux machines on a shared switch. Your machines, cables, and disks are saved in this browser.</p>
			</div>
			<form class="run" @submit=${this.#submit}>
				<div class="field-box">
					<span class="prompt" aria-hidden="true">:</span>
					<input
						id="start-line"
						aria-label="Command"
						name="line"
						type="text"
						autocomplete="off"
						spellcheck="false"
						.value=${image ? `spawn 2 ${image} --net switch0` : ""}
						@input=${() => {
							this.error = null;
						}}
					/>
				</div>
				<button type="submit" class="button primary lg">Run ↵</button>
			</form>
			${
				error === null
					? nothing
					: html`<div class="error" role="alert">
							<p>${error.message}</p>
							${error.fix === undefined ? nothing : html`<button type="button" class="link" @click=${() => this.#takeFix(error.fix ?? "")}>did you mean ${error.fix}</button>`}
						</div>`
			}
			${
				image === undefined
					? nothing
					: html`<div class="starts">
							<h2 class="label">or start from</h2>
							<ul role="list">
								${STARTING_POINTS.map((point) => {
									const line = point.line(image);
									return html`<li>
										<button type="button" @click=${() => this.runLine(line)}>
											<span class="title">${point.title}</span><span class="about">${point.about}</span><span class="line">${line}</span>
										</button>
									</li>`;
								})}
							</ul>
						</div>`
			}
			<p class="agent">
				Working with a coding agent? This page exposes ${tools} WebMCP tools, so it can boot and drive machines for you.
				<button type="button" class="link" @click=${this.#seeTools}>See the tools</button>
			</p>
		</div>`;
	}

	get #input(): HTMLInputElement | null {
		return this.querySelector("#start-line");
	}

	#takeFix(fix: string): void {
		const input = this.#input;
		if (input) input.value = fix;
		this.error = null;
		input?.focus();
	}

	readonly #seeTools = (): void => {
		this.app.store.dispatchUi({ type: "ui/agent-panel", open: true });
	};

	/** Errors show on Enter, never while typing, in the command's own words. */
	readonly #submit = async (event: SubmitEvent): Promise<void> => {
		event.preventDefault();
		const line = this.#input?.value ?? "";
		const { commands } = this.app;
		const parsed = commands.parse(line);
		if (!isLineError(parsed) && parsed.danger) {
			commands.confirmInBar(line);
			return;
		}
		try {
			const result = await commands.run(line, "bar");
			if (isLineError(result)) this.error = result;
			else if (result.kind === "failed") this.error = result.error;
		} catch (error) {
			console.error(`${line} failed`, error);
		}
	};
}

customElements.define("unlab-start", UnlabStart);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-start": UnlabStart;
	}
}
