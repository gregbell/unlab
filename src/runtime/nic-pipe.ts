// Ethernet frames on a byte pipe: each is a big-endian 16-bit length and that
// many bytes. unlab-nic.c is the other side.

const HEADER = 2;
/** The longest frame a length can say. */
export const FRAME_MAX = 0xffff;

/** The frames in order, as one chunk for the pipe. */
export function packFrames(frames: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(frames.reduce((n, frame) => n + HEADER + frame.length, 0));
	let at = 0;
	for (const frame of frames) {
		if (frame.length > FRAME_MAX) throw new RangeError(`a frame of ${frame.length} bytes`);
		out[at] = frame.length >> 8;
		out[at + 1] = frame.length & 255;
		out.set(frame, at + HEADER);
		at += HEADER + frame.length;
	}
	return out;
}

/** Cuts a pipe's chunks back into frames. A chunk may end anywhere, so what is left over waits for the next. */
export class FrameCutter {
	#left = new Uint8Array(0);

	/** Every frame the chunk completes, each in a buffer of its own. */
	push(chunk: Uint8Array): Uint8Array<ArrayBuffer>[] {
		let bytes = chunk;
		if (this.#left.length > 0) {
			bytes = new Uint8Array(this.#left.length + chunk.length);
			bytes.set(this.#left);
			bytes.set(chunk, this.#left.length);
		}
		const frames: Uint8Array<ArrayBuffer>[] = [];
		let at = 0;
		while (bytes.length - at >= HEADER) {
			const end = at + HEADER + ((bytes[at] << 8) | bytes[at + 1]);
			if (bytes.length < end) break;
			frames.push(new Uint8Array(bytes.subarray(at + HEADER, end)));
			at = end;
		}
		// A copy: the pipe may reuse the chunk once this returns.
		this.#left = new Uint8Array(bytes.subarray(at));
		return frames;
	}
}
