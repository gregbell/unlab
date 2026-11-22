import "./frame-detail.css";
import { html, nothing, type TemplateResult } from "lit";
import { type MachineName, selectPorts } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { FollowCapture } from "../capture/follow.ts";
import { type DetailField, frameDetail, type Words } from "./frame-detail-model.ts";

/**
 * Wire's decode of the selected frame: its header line, the ethernet group,
 * the protocol group, what switch0 did, and the bytes. A machine named
 * anywhere here takes its hue while it exists.
 */
export class UnlabFrameDetail extends UnlabElement {
	readonly #selected = new Select(this, (s) => s.capture.selected);
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #ports = new Select(this, selectPorts);

	constructor() {
		super();
		// The selected entry leaves the buffer on clear or when the ring wraps; that is the only change to watch for.
		new FollowCapture(this, (capture) => {
			const seq = this.#selected.value;
			return seq === null ? null : capture.entry(seq);
		});
	}

	override render(): TemplateResult {
		const seq = this.#selected.value;
		const entry = seq === null ? null : this.app.capture.entry(seq);
		if (entry?.kind !== "frame") {
			return html`<p class="nothing">Nothing selected</p>
				<p class="hint">Click a frame, or move through the list with the arrow keys.</p>`;
		}
		const ports = this.#ports.value;
		const d = frameDetail(entry, (port) => ports[port - 1]?.machine?.name ?? null);
		return html`<div class="head">
				<h2 class="title">${d.title}</h2>
				<span class="summary">${d.summary}</span>
			</div>
			${d.groups.map(
				(group) => html`<section class="group">
					<h3>${group.title}</h3>
					<dl>
						${group.fields.map((f) => this.#field(f))}
					</dl>
				</section>`,
			)}
			<section class="group">
				<h3>what switch0 did</h3>
				<p class="did">${d.did.map((words, i) => html`${i > 0 ? " " : ""}${this.#words(words)}`)}</p>
			</section>
			<section class="group">
				<h3>bytes</h3>
				<pre class="dump">${d.dump.map(
					(row) =>
						html`<span class="line"><span class="offset">${row.offset}</span>  ${row.runs.map(
							(run, i) => html`${i > 0 ? " " : ""}${this.#name(run.machine, run.text)}`,
						)}</span>`,
				)}</pre>
			</section>`;
	}

	#field(f: DetailField): TemplateResult {
		const who =
			f.who === null
				? nothing
				: f.who.kind === "everyone"
					? html` <span class="everyone">everyone</span>`
					: html` ${this.#name(f.who.name, f.who.name)}`;
		return html`<div class="pair"><dt>${f.label}</dt><dd>${f.value}${who}</dd></div>`;
	}

	#words(words: Words): TemplateResult {
		return html`${words.map((w) => (typeof w === "string" ? w : this.#name(w.machine, w.machine)))}`;
	}

	/** `text` in `name`'s hue while that machine exists; plain otherwise. */
	#name(name: MachineName | null, text: string): TemplateResult | string {
		const hue = name ? this.#machines.value[name]?.hue : undefined;
		return hue === undefined ? text : html`<span class="machine" data-hue=${hue}>${text}</span>`;
	}
}

customElements.define("unlab-frame-detail", UnlabFrameDetail);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-frame-detail": UnlabFrameDetail;
	}
}
