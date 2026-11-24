import "./capture.css";
import "../wire/frame-detail.ts";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { CaptureRow, FrameRow, LinkRow, RouteEnd } from "../../capture/index.ts";
import type { UiEvent } from "../../model/index.ts";
import { compileFilter, toPcap } from "../../net/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { FollowCapture } from "./follow.ts";

export type CaptureMode = "dock" | "full";

/** The id of the app's dock, which the dock's hide button controls. */
export const DOCK_ID = "unlab-dock";

const DOCK_ROWS = 8;
/** Row height in Wire. Every row, event rows too, is this tall, so the list can place any row by arithmetic. */
const ROW = 26;
/** Rows rendered beyond each edge of the viewport, so a fast scroll does not show blank. */
const OVERSCAN = 8;
/** How far a keyboard move looks for the next frame row past event rows. */
const SEEK = 64;

/**
 * The capture: a toolbar, the rows and the counters. `dock` shows the last
 * eight rows. `full` is Wire's: the whole buffer, virtualised, with the
 * match count, Save .pcap, a selection the arrow keys move and the frame
 * detail beside it.
 *
 * It reads frames from the capture while it renders and never copies them
 * into state; `capture.revision` decides when to render. The list is not a
 * live region: it would never stop talking.
 */
export class UnlabCapture extends UnlabElement {
	static override properties = { mode: { type: String, reflect: true } };
	declare mode: CaptureMode;

	readonly #ui = new Select(this, (s) => s.capture);
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #scroller: Ref<HTMLElement> = createRef();
	#resize: ResizeObserver | null = null;
	#viewport = 0;
	#scrollTop = 0;
	/** While true, the list stays scrolled to its newest row. Scrolling up turns it off; scrolling back down, on. */
	#following = true;

	constructor() {
		super();
		this.mode = "dock";
		new FollowCapture(this, (c) => c.revision);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.#resize?.disconnect();
		this.#resize = null;
	}

	override render(): TemplateResult {
		const full = this.mode === "full";
		const { filter, paused } = this.#ui.value;
		const compiled = compileFilter(filter);
		const capture = this.app.capture;
		const id = `capture-${this.mode}`;
		const counters = capture.counters;
		const list = html`${full ? this.#fullList() : this.#dockList()}
			<p class="counters">${counters.in} in · ${counters.delivered} delivered · ${counters.flooded} flooded</p>`;
		return html`<div class="toolbar">
				<span class="title">capture</span>
				<span class="status" data-paused=${paused}>${paused ? "paused" : "live"}</span>
				${full ? nothing : html`<span class="spacer"></span>`}
				<label for="${id}-filter" class="filter-label">filter</label>
				<input
					id="${id}-filter"
					class="field filter"
					type="text"
					autocomplete="off"
					spellcheck="false"
					placeholder="arp, icmp, node1…"
					aria-invalid=${compiled.ok ? "false" : "true"}
					aria-describedby=${compiled.ok ? nothing : `${id}-filter-error`}
					.value=${live(filter)}
					@input=${(e: InputEvent) => this.#onFilter(e)}
				/>
				${compiled.ok ? nothing : html`<span id="${id}-filter-error" class="visually-hidden">${compiled.error.message}</span>`}
				${full ? html`<span class="matches">${capture.matchedFrames} of ${capture.frameCount} frames</span><span class="spacer"></span>` : nothing}
				<button type="button" class="button" @click=${() => this.#dispatch({ type: "ui/capture-pause", paused: !paused })}>
					${paused ? "resume" : "pause"}
				</button>
				<button type="button" class="button" @click=${() => this.#dispatch({ type: "ui/capture-clear" })}>clear</button>
				${
					full
						? html`<button type="button" class="button" @click=${this.#save}>save .pcap</button>`
						: html`<a class="expand" href="#wire" @click=${this.#expand}>expand</a>
								<button
									type="button"
									class="button"
									aria-expanded="true"
									aria-controls=${DOCK_ID}
									@click=${() => this.#dispatch({ type: "ui/dock", dock: "collapsed" })}
								>
									hide
								</button>`
				}
			</div>
			${full ? html`<div class="body"><div class="list-column">${list}</div><unlab-frame-detail></unlab-frame-detail></div>` : list}`;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const scroller = this.#scroller.value;
		if (!scroller) return;
		if (!this.#resize) {
			this.#resize = new ResizeObserver(() => {
				this.#viewport = scroller.clientHeight;
				this.requestUpdate();
			});
			this.#resize.observe(scroller);
		}
		if (this.#following) scroller.scrollTop = scroller.scrollHeight;
	}

	#dockList(): TemplateResult {
		const rows = this.app.capture.tail(DOCK_ROWS);
		return html`<div class="rows">
			<div class="track" role="list" aria-label="Newest frames">
				${repeat(
					rows,
					(row) => row.seq,
					(row) => this.#row(row, { role: "listitem" }),
				)}
			</div>
		</div>`;
	}

	#fullList(): TemplateResult {
		const capture = this.app.capture;
		const total = capture.matchCount;
		const fits = Math.max(1, Math.ceil(this.#viewport / ROW));
		const top = this.#following ? Math.max(0, total - fits) : Math.floor(this.#scrollTop / ROW);
		const first = Math.max(0, top - OVERSCAN);
		const rows = capture.window(first, fits + 2 * OVERSCAN);
		const selected = this.#ui.value.selected;
		const active = selected !== null && rows.some((r) => r.seq === selected) ? `frame-${selected}` : nothing;
		return html`<div class="rows" ${ref(this.#scroller)} @scroll=${this.#onScroll}>
			<div
				class="track"
				role="listbox"
				tabindex="0"
				aria-label="Captured frames"
				aria-activedescendant=${active}
				style="height: ${(total + 1) * ROW}px"
				@keydown=${this.#onKey}
			>
				<div class="row heading" aria-hidden="true">
					<span>time</span><span>proto</span><span>route</span><span>len</span><span>info</span>
				</div>
				${repeat(
					rows,
					(row) => row.seq,
					(row, i) =>
						this.#row(row, {
							role: "option",
							top: (first + i + 1) * ROW,
							position: first + i + 1,
							size: total,
							selected: row.seq === selected,
						}),
				)}
			</div>
		</div>`;
	}

	#row(
		row: CaptureRow,
		at: {
			readonly role: "listitem" | "option";
			readonly top?: number;
			readonly position?: number;
			readonly size?: number;
			readonly selected?: boolean;
		},
	): TemplateResult {
		const style = at.top === undefined ? nothing : `top: ${at.top}px`;
		const position = at.position ?? nothing;
		const size = at.size ?? nothing;
		if (row.kind === "link") return this.#eventRow(row, at.role, style, position, size);
		const full = this.mode === "full";
		const selectable = at.role === "option";
		return html`<div
			class="row frame"
			id=${selectable ? `frame-${row.seq}` : nothing}
			role=${at.role}
			style=${style}
			aria-posinset=${position}
			aria-setsize=${size}
			aria-selected=${selectable ? String(at.selected === true) : nothing}
			data-hue=${this.#hue(row.from) ?? nothing}
			@click=${selectable ? () => this.#select(row.seq) : nothing}
		>
			<span class="time">${row.time}</span>
			<span class="proto">${row.proto}</span>
			<span class="route">${this.#end(row.from)} → ${this.#end(row.to)}</span>
			${full ? html`<span class="len">${row.len}</span>` : nothing}
			<span class="info">${row.info}${row.note ? html`<span class="note"> · ${row.note}</span>` : nothing}</span>
		</div>`;
	}

	#eventRow(
		row: LinkRow,
		role: "listitem" | "option",
		style: string | typeof nothing,
		position: number | typeof nothing,
		size: number | typeof nothing,
	): TemplateResult {
		return html`<div
			class="row event"
			role=${role}
			style=${style}
			aria-posinset=${position}
			aria-setsize=${size}
			aria-disabled=${role === "option" ? "true" : nothing}
			data-up=${row.up}
		>
			<span class="time">${row.time}</span>
			<span class="text">${row.text}. ${row.cause}</span>
		</div>`;
	}

	#end(end: RouteEnd): TemplateResult | string {
		if (end.kind === "everyone") return html`<span class="everyone">everyone</span>`;
		if (end.kind === "raw") return end.text;
		return html`<span class="machine" data-hue=${this.#hue(end) ?? nothing}>${end.nic ? `${end.name}:${end.nic}` : end.name}</span>`;
	}

	#hue(end: RouteEnd): number | null {
		return end.kind === "machine" ? (this.#machines.value[end.name]?.hue ?? null) : null;
	}

	#dispatch(event: UiEvent): void {
		this.app.store.dispatchUi(event);
	}

	#onFilter(event: InputEvent): void {
		if (event.target instanceof HTMLInputElement)
			this.#dispatch({ type: "ui/capture-filter", filter: event.target.value });
	}

	#select(seq: number | null): void {
		this.#dispatch({ type: "ui/frame-selected", seq });
	}

	readonly #expand = (event: Event): void => {
		event.preventDefault();
		this.#dispatch({ type: "ui/view", view: "wire" });
	};

	/** The whole buffer, ignoring the filter, timestamped on the wall clock. */
	readonly #save = (): void => {
		const bytes = toPcap(this.app.capture.frames(), Date.now() - this.app.store.state.now);
		const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.tcpdump.pcap" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = "unlab-switch0.pcap";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	};

	readonly #onScroll = (event: Event): void => {
		if (!(event.currentTarget instanceof HTMLElement)) return;
		const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
		this.#scrollTop = scrollTop;
		this.#following = scrollTop + clientHeight >= scrollHeight - ROW / 2;
		this.requestUpdate();
	};

	readonly #onKey = (event: KeyboardEvent): void => {
		const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : null;
		if (step === null) return;
		event.preventDefault();
		const capture = this.app.capture;
		const selected = this.#ui.value.selected;
		const from = selected === null ? -1 : capture.indexOf(selected);
		const start = from >= 0 ? from + step : this.#visibleEdge(step);
		const target = this.#seekFrame(start, step);
		if (target === null) return;
		this.#reveal(target.index);
		this.#select(target.seq);
	};

	/** From nothing selected, Down starts at the top row in view and Up at the bottom one. */
	#visibleEdge(step: 1 | -1): number {
		const scroller = this.#scroller.value;
		if (!scroller) return -1;
		const top = Math.floor(scroller.scrollTop / ROW);
		if (step > 0) return top;
		const bottom = Math.floor((scroller.scrollTop + scroller.clientHeight) / ROW) - 2;
		return Math.max(top, Math.min(this.app.capture.matchCount - 1, bottom));
	}

	/** The nearest frame row at or past `index` going `step`, skipping event rows. */
	#seekFrame(index: number, step: 1 | -1): { readonly index: number; readonly seq: number } | null {
		const capture = this.app.capture;
		for (let at = index; at >= 0 && at < capture.matchCount; at += step * SEEK) {
			const from = step > 0 ? at : Math.max(0, at - SEEK + 1);
			const chunk: readonly CaptureRow[] = capture.window(from, step > 0 ? SEEK : at - from + 1);
			const order = step > 0 ? chunk : [...chunk].reverse();
			const offset = order.findIndex((row): row is FrameRow => row.kind === "frame");
			const found = order[offset];
			if (found) return { index: step > 0 ? at + offset : at - offset, seq: found.seq };
		}
		return null;
	}

	/** Scrolls just enough that row `index` sits fully below the sticky heading. */
	#reveal(index: number): void {
		const scroller = this.#scroller.value;
		if (!scroller) return;
		const viewport = scroller.clientHeight;
		const lowest = (index + 2) * ROW - viewport;
		const highest = index * ROW;
		scroller.scrollTop = Math.min(highest, Math.max(lowest, scroller.scrollTop));
	}
}

customElements.define("unlab-capture", UnlabCapture);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-capture": UnlabCapture;
	}
}
