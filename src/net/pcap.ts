// A libpcap capture file (https://wiki.wireshark.org/Development/LibpcapFileFormat):
// little-endian, version 2.4, LINKTYPE_ETHERNET, microsecond timestamps.

import type { CaptureFilter, CarriedFrame, FilterPlace } from "./filter.ts";
import { onWire } from "./frames.ts";

export interface PcapFrame {
	/** Milliseconds since `startEpochMs`. */
	readonly t: number;
	readonly bytes: Uint8Array;
}

const MAGIC = 0xa1b2c3d4;
const SNAPLEN = 262_144;
const LINKTYPE_ETHERNET = 1;
const GLOBAL_HEADER = 24;
const RECORD_HEADER = 16;

export function toPcap(frames: Iterable<PcapFrame>, startEpochMs = 0): Uint8Array {
	const list = Array.from(frames);
	const size = list.reduce((n, f) => n + RECORD_HEADER + f.bytes.length, GLOBAL_HEADER);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint32(0, MAGIC, true);
	view.setUint16(4, 2, true);
	view.setUint16(6, 4, true);
	view.setUint32(16, SNAPLEN, true);
	view.setUint32(20, LINKTYPE_ETHERNET, true);

	let o = GLOBAL_HEADER;
	for (const f of list) {
		const us = Math.round((startEpochMs + f.t) * 1000);
		const sec = Math.floor(us / 1e6);
		view.setUint32(o, sec, true);
		view.setUint32(o + 4, us - sec * 1e6, true);
		view.setUint32(o + 8, f.bytes.length, true);
		view.setUint32(o + 12, f.bytes.length, true);
		out.set(f.bytes, o + RECORD_HEADER);
		o += RECORD_HEADER + f.bytes.length;
	}
	return out;
}

export const PCAP_TYPE = "application/vnd.tcpdump.pcap";

/** A frame as a switch carried it, with what a .pcap needs of it. */
export interface CapturedFrame extends CarriedFrame {
	/** Milliseconds after the capture's clock read 0. */
	readonly t: number;
	readonly vlan: number;
	/** The ports it had an 802.1Q tag on, as a mask. */
	readonly tagged: number;
}

/** A capture saved as a .pcap. */
export interface PcapFile {
	readonly name: string;
	readonly frames: number;
	readonly bytes: Uint8Array;
}

/**
 * A filter that names a switch or a cable says where to look, so what is saved
 * is what it shows, and one cable's file has each frame once. Any other filter
 * is for reading, and every frame is saved, once for each switch that carried it.
 */
export function narrows(filter: CaptureFilter): boolean {
	return filter.scope.kind !== "everywhere";
}

/** `unlab-lan-port3.pcap`, `unlab-filtered.pcap`, or for the whole capture `unlab.pcap`, or `unlab-switch0.pcap` in a lab of one switch. */
export function pcapName({ scope }: CaptureFilter, switches: readonly string[]): string {
	if (scope.kind === "everywhere") return switches.length === 1 ? `unlab-${switches[0]}.pcap` : "unlab.pcap";
	if (scope.kind === "places") return "unlab-filtered.pcap";
	return `unlab-${scope.switch}${scope.port === null ? "" : `-port${scope.port}`}.pcap`;
}

/**
 * Each as it was on the wire: at a port of its switch that the filter names a
 * cable by, or else as it came into the switch, with its tag if it had one there.
 */
function* wired(frames: Iterable<CapturedFrame>, places: readonly FilterPlace[]): Generator<PcapFrame> {
	for (const e of frames) {
		const at = places.find(
			({ switch: on, port }) =>
				on === e.switch && port !== null && (e.from === port || (e.to & (1 << (port - 1))) !== 0),
		);
		yield { t: e.t, bytes: onWire(e.bytes, e.vlan, e.tagged, at?.port ?? e.from) };
	}
}

function* matching(frames: Iterable<CapturedFrame>, filter: CaptureFilter): Generator<CapturedFrame> {
	for (const frame of frames) if (filter.matchesFrame(frame)) yield frame;
}

/** What save .pcap saves of the frames under a filter, stamped from the wall clock `startEpochMs`, when `t` was 0. */
export function pcapOf(
	frames: Iterable<CapturedFrame>,
	filter: CaptureFilter,
	switches: readonly string[],
	startEpochMs: number,
): PcapFile {
	const { scope } = filter;
	const places = scope.kind === "everywhere" ? [] : scope.kind === "places" ? scope.places : [scope];
	const saved = [...wired(narrows(filter) ? matching(frames, filter) : frames, places)];
	return { name: pcapName(filter, switches), frames: saved.length, bytes: toPcap(saved, startEpochMs) };
}
