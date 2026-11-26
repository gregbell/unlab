import "./capture.css";
import "./frame-detail.ts";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import type { CaptureRow, CaptureView, FrameRow, LinkRow, RouteEnd } from "../../capture/index.ts";
import { andList, type SwitchName, selectNames, type UiEvent } from "../../model/index.ts";
import { compileFilter, EVERYONE, type PcapFrame, toPcap } from "../../net/index.ts";
import { clearIcon, pauseIcon, resumeIcon, Select, UnlabElement, windowButtons } from "../base/index.ts";
import { FollowCapture } from "./follow.ts";

export type CaptureMode = "dock" | "full";

const DOCK_ROWS = 8;
/** Row height in the full list. Every row, event rows too, is this tall, so the list can place any row by arithmetic. */
const ROW = 26;
/** Rows rendered beyond each edge of the viewport, so a fast scroll does not show blank. */
const OVERSCAN = 8;
/** How far a keyboard move looks for the next frame row past event rows. */
const SEEK = 64;

function endText(end: RouteEnd): string {
	switch (end.kind) {
		case "everyone":
			return EVERYONE;
		case "raw":
			return end.text;
		case "machine":
			return end.nic ? `${end.name}:${end.nic}` : end.name;
	}
}

/** What to save of the capture, and under what name. */
interface Saved {
	readonly frames: Iterable<PcapFrame>;
	readonly name: string;
	/** What the button adds to its name, when it is not all that was captured. */
	readonly title: string | null;
}

/**
 * A filter that names a switch or a cable says where to look, so what is saved
 * is what it shows, and one cable's file has each frame once. Any other filter
 * is for reading, and every frame is saved, once for each switch that carried it.
 */
function saved(capture: CaptureView, switches: readonly SwitchName[]): Saved {
	const { scope } = capture.filter;
	if (scope.kind === "everywhere") {
		const [first, ...others] = switches;
		const name = others.length === 0 ? `unlab-${first}.pcap` : "unlab.pcap";
		return { frames: capture.frames(), name, title: null };
	}
	const what = scope.kind === "places" ? "filtered" : scope.switch + (scope.port === null ? "" : `-port${scope.port}`);
	return { frames: capture.matched(), name: `unlab-${what}.pcap`, title: "Save the frames shown" };
}

/** `On lan, in by port 3 and out of ports 4 and 5.` */
function viaTitle(row: FrameRow): string {
	const out = row.out ?? [];
	const went = out.length === 0 ? "out of none" : `out of ${out.length === 1 ? "port" : "ports"} ${andList(out)}`;
	return `On ${row.switch}, in by port ${row.in} and ${went}.`;
}

/**
 * The capture: a toolbar, the rows and the counters. `dock`, under the panes,
 * shows the last eight rows, each cut to the width there is. `full` is the
 * maximised panel: the whole buffer, virtualised, with the match count, Save
 * .pcap, a selection the arrow keys move and the frame detail beside it.
 *
 * It reads frames from the capture while it renders and never copies them
 * into state; `capture.revision` decides when to render. The list is not a
 * live region: it would never stop talking.
 *
 * Rows are drawn by their place in the list and not keyed by their frame. A
 * storm goes through hundreds of rows a second, and lit's `repeat` leaves a
 * marker node behind for each keyed row that goes, which slows every later
 * change to the list.
 */
export class UnlabCapture extends UnlabElement {
	static override properties = { mode: { type: String, reflect: true } };
	declare mode: CaptureMode;

	readonly #ui = new Select(this, (s) => s.capture);
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #names = new Select(this, selectNames);
	/** Rows name the switch when there are several. */
	readonly #switches = new Select(this, (s) => s.switches);
	readonly #scroller: Ref<HTMLElement> = createRef();
	/** The full list's scroller, while there is one. */
	#observed: HTMLElement | null = null;
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
		this.#observe(null);
	}

	override render(): TemplateResult {
		const full = this.mode === "full";
		const { filter, paused } = this.#ui.value;
		const compiled = compileFilter(filter, this.#names.value);
		const capture = this.app.capture;
		const id = `capture-${this.mode}`;
		const counters = capture.counters;
		const list = html`${full ? this.#fullList() : this.#dockList()}
			<p class="counters">${counters.in} in · ${counters.delivered} delivered · ${counters.flooded} flooded</p>`;
		return html`<div class="toolbar">
				<span class="title">capture</span>
				<span class="status" data-paused=${paused}>${paused ? "paused" : "live"}</span>
				<span class="spacer"></span>
				<label for="${id}-filter" class="visually-hidden">filter</label>
				<input
					id="${id}-filter"
					class="field filter"
					type="text"
					autocomplete="off"
					spellcheck="false"
					placeholder="filter: arp, icmp…"
					aria-invalid=${compiled.ok ? "false" : "true"}
					aria-describedby=${compiled.ok ? nothing : `${id}-filter-error`}
					.value=${live(filter)}
					@input=${(e: InputEvent) => this.#onFilter(e)}
				/>
				${compiled.ok ? nothing : html`<span id="${id}-filter-error" class="visually-hidden">${compiled.error.message}</span>`}
				${full ? html`<span class="matches">${capture.matchedFrames} of ${capture.frameCount} frames</span>` : nothing}
				<button
					type="button"
					class="button"
					title=${paused ? "Resume" : "Pause"}
					@click=${() => this.#dispatch({ type: "ui/capture-pause", paused: !paused })}
				>
					${paused ? resumeIcon : pauseIcon}<span class="label">${paused ? "resume" : "pause"}</span>
				</button>
				<button type="button" class="button" title="Clear" @click=${() => this.#dispatch({ type: "ui/capture-clear" })}>
					${clearIcon}<span class="label">clear</span>
				</button>
				${full ? html`<button type="button" class="button" title=${saved(capture, this.#switches.value).title ?? nothing} @click=${this.#save}>save .pcap</button>` : nothing}
				<span class="window">${windowButtons("capture", full, {
					maximise: () => this.#dispatch({ type: "ui/panel-maximised", panel: "capture" }),
					park: () => this.#dispatch({ type: "ui/panel-parked", panel: "capture" }),
				})}</span>
			</div>
			${full ? html`<div class="body"><div class="list-column">${list}</div><unlab-frame-detail></unlab-frame-detail></div>` : list}`;
	}

	protected override updated(changed: PropertyValues<this>): void {
		super.updated(changed);
		const scroller = this.#scroller.value ?? null;
		if (scroller !== this.#observed) this.#observe(scroller);
		if (scroller && this.#following) scroller.scrollTop = scroller.scrollHeight;
	}

	/** Each time the panel is maximised it has a new list, which starts at its newest row. */
	#observe(scroller: HTMLElement | null): void {
		this.#resize?.disconnect();
		this.#resize = null;
		this.#observed = scroller;
		this.#following = true;
		if (!scroller) return;
		this.#resize = new ResizeObserver(() => {
			this.#viewport = scroller.clientHeight;
			this.requestUpdate();
		});
		this.#resize.observe(scroller);
	}

	#dockList(): TemplateResult {
		const rows = this.app.capture.tail(DOCK_ROWS);
		const via = this.#showsVia(rows);
		return html`<div class="rows" data-via=${via}>
			<div class="track" role="list" aria-label="Newest frames">
				${rows.map((row) => this.#row(row, { role: "listitem" }, via))}
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
		const via = this.#showsVia(rows);
		return html`<div class="rows" data-via=${via} ${ref(this.#scroller)} @scroll=${this.#onScroll}>
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
					<span>time</span><span>proto</span>${via ? html`<span>switch</span>` : nothing}<span>route</span><span>len</span><span>info</span>
				</div>
				${rows.map((row, i) =>
					this.#row(
						row,
						{
							role: "option",
							top: (first + i + 1) * ROW,
							position: first + i + 1,
							size: total,
							selected: row.seq === selected,
						},
						via,
					),
				)}
			</div>
		</div>`;
	}

	/** Where each frame was carried is a column of its own in a lab of several switches, or for what a switch that is gone carried. */
	#showsVia(rows: readonly CaptureRow[]): boolean {
		return this.#switches.value.length > 1 || rows.some((row) => row.kind === "frame" && row.switch);
	}

	/** `lan 3 → 4,5`. */
	#via(row: FrameRow): TemplateResult {
		if (!row.switch) return html`<span class="via"></span>`;
		return html`<span class="via" title=${viaTitle(row)}
			><span>${row.switch}</span> <span>${row.in} → ${row.out?.join(",") || "none"}</span></span
		>`;
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
		via: boolean,
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
			${via ? this.#via(row) : nothing}
			<span class="route" title=${`${endText(row.from)} → ${endText(row.to)}`}
				>${this.#end(row.from)} <span>→</span> ${this.#end(row.to)}</span
			>
			${full ? html`<span class="len">${row.len}</span>` : nothing}
			<span class="info" title=${full ? nothing : row.info + (row.note ? ` · ${row.note}` : "")}>${row.info}${row.note ? html`<span class="note"> · ${row.note}</span>` : nothing}</span>
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
			<span class="text" title=${`${row.text}. ${row.cause}`}>${row.text}. ${row.cause}</span>
		</div>`;
	}

	#end(end: RouteEnd): TemplateResult {
		const named = end.kind === "machine";
		return html`<span class=${named ? "machine" : end.kind} data-hue=${this.#hue(end) ?? nothing}>${endText(end)}</span>`;
	}

	#hue(end: RouteEnd): number | null {
		const machine = end.kind === "machine" ? this.#machines.value[end.name] : undefined;
		// The name can be another machine's by now.
		return machine && end.kind === "machine" && machine.n === end.n ? machine.hue : null;
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

	/** Timestamped on the wall clock. */
	readonly #save = (): void => {
		const { frames, name } = saved(this.app.capture, this.#switches.value);
		const bytes = toPcap(frames, Date.now() - this.app.store.state.now);
		const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.tcpdump.pcap" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = name;
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
