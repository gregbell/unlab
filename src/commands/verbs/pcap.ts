import { selectNames } from "../../model/index.ts";
import { type CaptureFilter, compileFilter, narrows, PCAP_TYPE, pcapName, pcapOf } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { lineError } from "../types.ts";
import { count } from "./words.ts";

/**
 * The most of a file that capture_save returns. Its base64, a third more, has to go in one message over the CLI's
 * link, which takes 4 MiB at most.
 */
export const MAX_PCAP_BYTES = 2 * 2 ** 20;
const MAX_TEXT = `${MAX_PCAP_BYTES / 2 ** 20} MiB`;

/** A saved capture, as `capture_save` returns it. */
export interface PcapData {
	/** `unlab-lan-port3.pcap`. */
	readonly name: string;
	readonly frames: number;
	/** The file's length. */
	readonly size: number;
	/** The file in base64, for an agent. A person's browser downloads it instead. */
	readonly bytes?: string;
}

interface PcapPlan {
	readonly source: string;
	readonly filter: CaptureFilter;
	readonly name: string;
}

function base64(bytes: Uint8Array): string {
	let text = "";
	for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(text);
}

const filter = slots.frameFilter();

/**
 * A filter that is surely narrower than the one whose file was too big: one cable when it named no switch or cable,
 * and the same with icmp when it does not name icmp yet. Null when no single term would narrow it.
 */
export function narrowerThan(source: string, narrowed: boolean, first: string): string | null {
	if (!narrowed) return `${first}:1`;
	return /\bicmp\b/.test(source) ? null : `${source.trim()} icmp`;
}

export const pcap = defineVerb({
	name: "pcap",
	about: "save the capture as a .pcap",
	description: `Save the capture as a .pcap, as save .pcap does in the capture panel. A filter that names a switch (lan) or a cable (lan:3) saves only the frames it matches, as they were on that cable, so one cable's file has each frame once. Any other filter saves every frame, once for each switch that carried it. In the command bar it downloads the file. capture_save returns its name, frames, size, and bytes in base64, up to ${MAX_TEXT}. Frames come from the guests.`,
	danger: false,
	grammar: { filter },
	example: { filter: "switch0:1" },
	plan(a, lab, ctx) {
		const fault = filter.check?.(a.filter, ctx);
		if (fault) return refuse(fault.message, "filter");
		const compiled = compileFilter(a.filter, selectNames(lab));
		if (!compiled.ok) return refuse(compiled.error.message, "filter");
		return { source: a.filter, filter: compiled.filter, name: pcapName(compiled.filter, lab.switches) };
	},
	describe({ source, filter, name }: PcapPlan) {
		if (narrows(filter)) return `save the frames that ${source} matches as ${name}`;
		const all = `save every captured frame as ${name}`;
		return source === "" ? all : `${all} · ${source} names no switch or cable, so the file has them all`;
	},
	async execute({ source, filter }, ctx, deps) {
		const { switches } = deps.state();
		const file = pcapOf(deps.capture.frames(), filter, switches, deps.capture.startedAt);
		const data: PcapData = { name: file.name, frames: file.frames, size: file.bytes.length };
		const frames = count(file.frames, "frame");
		if (ctx.source !== "agent") {
			deps.download(file.name, PCAP_TYPE, file.bytes);
			return { kind: "visible", text: `saved ${file.name} to downloads · ${frames}`, data };
		}
		if (file.bytes.length > MAX_PCAP_BYTES) {
			const narrower = narrowerThan(source, narrows(filter), switches[0]);
			const too = `${file.name} would hold ${frames}, more than fit in the ${MAX_TEXT} that capture_save returns`;
			const fix = narrower
				? `narrow the filter, such as to ${narrower}`
				: "a person can save it with save .pcap in the capture panel";
			return { kind: "failed", error: lineError(`${too}, so ${fix}.`) };
		}
		return { kind: "visible", text: `${file.name} · ${frames}`, data: { ...data, bytes: base64(file.bytes) } };
	},
	tool: {
		name: "capture_save",
		title: "Save captured frames as a .pcap",
		policy: "run",
		annotations: { readOnlyHint: true, untrustedContentHint: true },
	},
});
