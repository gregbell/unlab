import "./spawn-form.css";
import { html, nothing, type TemplateResult } from "lit";
import { isLineError, MULTICPU_BLOCKER } from "../../commands/index.ts";
import { DISK_SIZES } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { defaultChoice, formView, MEMORY, type Memory, type SpawnChoice } from "./form.ts";

const memoryLabel = (mib: Memory): string => (mib >= 1024 ? `${mib / 1024} GiB` : `${mib} MiB`);

/**
 * Add machines: `spawn` as a form. Each choice is an argument; the line, its
 * validation and execution use the same command as the bar. It starts afresh each time the view opens, because the app mounts
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
		const firstRun = lab.rail.length === 0;
		const distro = lab.images.find((image) => image.name === choice.image)?.label ?? choice.image;
		const view = formView(choice, lab, this.app.commands);
		const pick = (patch: Partial<SpawnChoice>) => () => {
			this.choice = { ...this.choice, ...patch };
		};
		const option = (label: string, pressed: boolean, patch: Partial<SpawnChoice>) =>
			html`<button type="button" class="choice" aria-pressed=${pressed ? "true" : "false"} @click=${pick(patch)}>${label}</button>`;

		return html`<div class="sheet">
			<header class="intro">
				<h1>${firstRun ? "Your Linux lab in a tab." : "Add machines"}</h1>
				${firstRun ? html`<p>Boot Alpine or Debian machines on a shared network. They run on your device, and their files stay in this browser.</p>` : nothing}
			</header>
			<div class="choices-column">
				<div class="question" role="group" aria-labelledby="spawn-count">
					<div class="label" id="spawn-count">Machines</div>
					<div class="stepper">
						<button type="button" class="step" aria-label="One fewer" ?disabled=${choice.count <= 1} @click=${pick({ count: choice.count - 1 })}>−</button>
						<span class="count">${choice.count}</span>
						<button type="button" class="step" aria-label="One more" ?disabled=${choice.count >= view.most} @click=${pick({ count: choice.count + 1 })}>+</button>
					</div>
				</div>
				<div class="question">
					<div class="label" id="spawn-image">Distribution</div>
					<div class="choices" role="group" aria-labelledby="spawn-image">
						${lab.images.map((image) => option(image.label, choice.image === image.name, { image: image.name }))}
					</div>
				</div>
				<details class="customize">
					<summary>Customize machines</summary>
					<div class="question">
						<div class="label" id="spawn-memory">Memory per machine</div>
						<div class="choices" role="group" aria-labelledby="spawn-memory">
							${MEMORY.map((mib) => option(memoryLabel(mib), choice.mem === mib, { mem: mib }))}
						</div>
						<p class="note memory-note">${view.memoryNote}</p>
					</div>
					<div class="question">
						<label class="label" for="spawn-cpus">CPUs each</label>
						<select class="field" id="spawn-cpus" @change=${(event: Event) => {
							if (event.target instanceof HTMLSelectElement) pick({ cpus: Number(event.target.value) })();
						}}>
							${[1, 2, 4, 8, 16].map((n) => html`<option .value=${String(n)} ?selected=${choice.cpus === n} ?disabled=${n > 1 && !!MULTICPU_BLOCKER}>${n}</option>`)}
						</select>
						${MULTICPU_BLOCKER ? html`<p class="note">Multiple CPUs unavailable: ${MULTICPU_BLOCKER}.</p>` : nothing}
					</div>
					<div class="question">
						<div class="label" id="spawn-disk">Disk per machine</div>
						<div class="choices" role="group" aria-labelledby="spawn-disk">
							${DISK_SIZES.map((disk) => option(`${disk} GiB`, choice.disk === disk, { disk }))}
						</div>
					</div>
					<div class="question">
						<div class="label" id="spawn-network">Network</div>
						<div class="choices" role="group" aria-labelledby="spawn-network">
							${option("plug into switch0", choice.net === "switch0", { net: "switch0" })}
							${option("leave unplugged", choice.net === "none", { net: "none" })}
						</div>
						<p class="note">${view.networkNote}</p>
					</div>
				</details>
			</div>
			<div class="result-column">
				<div class="you-get">
					<h2 class="label">Network preview</h2>
					<p class="network-summary">${distro} · ${choice.net === "none" ? "unplugged" : "switch0"}</p>
					<ul role="list">
						${view.machines.map(
							(m) => html`<li data-hue=${m.hue}>
								<span class="name">${m.name}</span><span class="where">${m.address}</span><span class="port">${m.port}</span>
							</li>`,
						)}
					</ul>
				</div>
				${view.error ? html`<p class="error" role="alert">${view.error.message}</p>` : nothing}
				<div class="actions">
					<button type="button" class="button primary lg" ?disabled=${view.error !== null || this.running} @click=${() => void this.#boot(view.line)}>
						${view.bootLabel}
					</button>
					${firstRun ? nothing : html`<button type="button" class="link" @click=${this.#close}>Cancel</button>`}
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
