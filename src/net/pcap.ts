// A libpcap capture file (https://wiki.wireshark.org/Development/LibpcapFileFormat):
// little-endian, version 2.4, LINKTYPE_ETHERNET, microsecond timestamps.

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
