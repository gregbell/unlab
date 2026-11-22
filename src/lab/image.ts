// Distro images, fetched once and shared by every machine.
//
// Each worker used to open the image over HTTP itself, with Range requests.
// Several workers starting at once on the same URL hit the browser's cache
// concurrently and some of them get a short read, so the page fetches each
// image a single time instead and hands every machine the same bytes. On a
// cross-origin isolated page that is a SharedArrayBuffer and costs one copy
// in total; otherwise each worker gets its own copy of the array.

import type { BlockDevice } from "unkernel";

const images = new Map<string, Promise<ArrayBufferLike>>();

export interface ImageProgress {
	loaded: number;
	total: number;
}

/** Fetch an image once; later callers share the first result. */
export function loadImage(
	url: string,
	size: number,
	onProgress?: (p: ImageProgress) => void,
): Promise<ArrayBufferLike> {
	const found = images.get(url);
	if (found) return found;
	const p = fetchImage(url, size, onProgress);
	images.set(url, p);
	// A failed fetch must not be remembered as the answer for ever.
	void p.catch(() => images.delete(url));
	return p;
}

async function fetchImage(
	url: string,
	size: number,
	onProgress?: (p: ImageProgress) => void,
): Promise<ArrayBufferLike> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	const total = Number(res.headers.get("content-length")) || size;

	const buf: ArrayBufferLike = crossOriginIsolated ? new SharedArrayBuffer(total) : new ArrayBuffer(total);
	const out = new Uint8Array(buf);

	if (!res.body) {
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length !== total) throw new Error(`${url}: got ${bytes.length} bytes, expected ${total}`);
		out.set(bytes);
		onProgress?.({ loaded: total, total });
		return buf;
	}

	const reader = res.body.getReader();
	let at = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (at + value.length > out.length) throw new Error(`${url}: longer than the ${total} bytes expected`);
		out.set(value, at);
		at += value.length;
		onProgress?.({ loaded: at, total });
	}
	if (at !== total) throw new Error(`${url}: got ${at} bytes, expected ${total}`);
	return buf;
}

/**
 * A read-only block device over bytes already in memory: what each machine
 * gets as its distro disk. The guest never writes it (the root overlay takes
 * the writes), so write() is only here to satisfy the interface.
 */
export class MemoryDisk implements BlockDevice {
	readonly size: number;
	readonly readOnly = true;
	readonly #bytes: Uint8Array;

	constructor(buf: ArrayBufferLike) {
		this.#bytes = new Uint8Array(buf);
		this.size = this.#bytes.length;
	}

	read(off: number, views: Uint8Array[]): void {
		let at = off;
		for (const v of views) {
			// A read past the end would otherwise copy a short slice silently.
			if (at + v.length > this.#bytes.length)
				throw new Error(`read past the end of the image: ${at}+${v.length} > ${this.#bytes.length}`);
			v.set(this.#bytes.subarray(at, at + v.length));
			at += v.length;
		}
	}

	write(): never {
		throw new Error("the distro image is read-only");
	}
}
