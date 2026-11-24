import "./spawn-form.css";
import { html, nothing, type TemplateResult } from "lit";
import { isLineError } from "../../commands/index.ts";
import { DISK_SIZES } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { defaultChoice, formView, MEMORY, type Memory, type SpawnChoice } from "./form.ts";

const memoryLabel = (mib: Memory): string => (mib >= 1024 ? `${mib / 1024} GiB` : `${mib} MiB`);

/**
 * Add machines: `spawn` as a form. Each choice is an argument; the line, its
 * preview and its errors are the bar's own, and Boot runs exactly the line
 * shown. It starts afresh each time the view opens, because the app mounts
 * it only while the view is open.
 */
export class UnlabSpawnForm extends UnlabElement {
	static override properties = { choice: { state: true }, running: { state: true } };
	declare choice: SpawnChoice;
	declare running: boolean;

	// Room, ports, hues, names and the parse all read the lab, so the form follows all of it.
	readonly #lab = new Select(this, (state) => state);

	override connectedCallback(): void {
		super.connectedCallback();
		this.choice ??= defaultChoice(this.app.store.state);
		this.running ??= false;
	}

	override render(): TemplateResult {
		const { choice } = this;
		const lab = this.#lab.value;
		const view = formView(choice, lab, this.app.commands);
		const pick = (patch: Partial<SpawnChoice>) => () => {
			this.choice = { ...this.choice, ...patch };
		};
		const option = (label: string, pressed: boolean, patch: Partial<SpawnChoice>) =>
			html`<button type="button" class="choice" aria-pressed=${pressed ? "true" : "false"} @click=${pick(patch)}>${label}</button>`;

		return html`<div class="sheet">
			<div class="back">
				<button type="button" class="link" @click=${this.#close}>← back to the lab</button>
			</div>
			<div class="choices-column">
				<h1>Add machines</h1>
				<div class="question" role="group" aria-labelledby="spawn-count">
					<div class="label" id="spawn-count">how many</div>
					<div class="stepper">
						<button type="button" class="step" aria-label="One fewer" ?disabled=${choice.count <= 1} @click=${pick({ count: choice.count - 1 })}>−</button>
						<span class="count">${choice.count}</span>
						<button type="button" class="step" aria-label="One more" ?disabled=${choice.count >= view.most} @click=${pick({ count: choice.count + 1 })}>+</button>
						<span class="note">${view.memoryNote}</span>
					</div>
				</div>
				<div class="question">
					<div class="label" id="spawn-image">image</div>
					<div class="choices" role="group" aria-labelledby="spawn-image">
						${lab.images.map((image) => option(image.label, choice.image === image.name, { image: image.name }))}
					</div>
				</div>
				<div class="question">
					<div class="label" id="spawn-memory">memory each</div>
					<div class="choices" role="group" aria-labelledby="spawn-memory">
						${MEMORY.map((mib) => option(memoryLabel(mib), choice.mem === mib, { mem: mib }))}
					</div>
				</div>
				<div class="question">
					<label class="label" for="spawn-cpus">CPUs each</label>
					<select class="field" id="spawn-cpus" @change=${(event: Event) => {
						if (event.target instanceof HTMLSelectElement) pick({ cpus: Number(event.target.value) })();
					}}>
						${[1, 2, 4, 8, 16].map((n) => html`<option .value=${String(n)} ?selected=${choice.cpus === n} ?disabled=${n > 1 && !crossOriginIsolated}>${n}</option>`)}
					</select>
					${crossOriginIsolated ? nothing : html`<p class="note">Multiple CPUs require cross-origin isolation.</p>`}
				</div>
				<div class="question">
					<div class="label" id="spawn-disk">persistent disk each</div>
					<div class="choices" role="group" aria-labelledby="spawn-disk">
						${DISK_SIZES.map((disk) => option(`${disk} GiB`, choice.disk === disk, { disk }))}
					</div>
				</div>
				<div class="question">
					<div class="label" id="spawn-network">network</div>
					<div class="choices" role="group" aria-labelledby="spawn-network">
						${option("plug into switch0", choice.net === "switch0", { net: "switch0" })}
						${option("leave unplugged", choice.net === "none", { net: "none" })}
					</div>
					<p class="note">${view.networkNote}</p>
				</div>
			</div>
			<div class="result-column">
				<div class="you-get">
					<h2 class="label">you get</h2>
					<ul role="list">
						${view.machines.map(
							(m) => html`<li data-hue=${m.hue}>
								<span class="name">${m.name}</span><span class="where">${m.address}</span><span class="port">${m.port}</span>
							</li>`,
						)}
					</ul>
				</div>
				<div class="equivalents">
					<h2 class="label">same thing from the command bar</h2>
					<div class="code line"><span class="prompt" aria-hidden="true">:</span> ${view.line}</div>
					${
						view.check.ok
							? html`<div class="preview" data-tone=${view.check.preview.tone}>
									<span class="will-label">will</span><span class="will">${view.check.preview.will}</span>
									${view.check.preview.assumed === null ? nothing : html`<span class="assumed">${view.check.preview.assumed}</span>`}
								</div>`
							: html`<p class="error" role="alert">${view.check.error.message}</p>`
					}
					<h2 class="label">and from an agent</h2>
					<div class="code call">${view.call}</div>
				</div>
				<div class="actions">
					<button type="button" class="button primary lg" ?disabled=${!view.check.ok || this.running} @click=${() => void this.#boot(view.line)}>
						${view.bootLabel}
					</button>
					<button type="button" class="link" @click=${this.#close}>Cancel</button>
				</div>
			</div>
		</div>`;
	}

	readonly #close = (): void => {
		this.app.store.dispatchUi({ type: "ui/view", view: "lab" });
	};

	async #boot(line: string): Promise<void> {
		this.running = true;
		try {
			const result = await this.app.commands.run(line, "button");
			if (!isLineError(result) && result.kind !== "failed") this.#close();
		} catch (error) {
			console.error(`${line} failed`, error);
		} finally {
			this.running = false;
		}
	}
}

customElements.define("unlab-spawn-form", UnlabSpawnForm);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-spawn-form": UnlabSpawnForm;
	}
}
