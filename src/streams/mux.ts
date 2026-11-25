// Many byte streams over one message channel, with flow control and half-close
// for each, as TCP has. Both ends of the CLI's link run this: a machine's worker
// in the browser and the CLI under Node. Either end opens a stream by saying
// what it wants to reach, and the other answers that it is open or why not.
//
// Every message is a type, the stream's number and a payload. The end that
// dialled the channel opens odd numbers and the other end even ones.

const OPEN = 1;
const OPENED = 2;
const REFUSED = 3;
const DATA = 4;
const CREDIT = 5;
const END = 6;
const RESET = 7;

const HEAD = 5;
/** A stream's bytes that may be on their way. */
export const WINDOW = 512 * 1024;
/** The most bytes of one message, so that no stream holds the others up for long. */
const CHUNK = 64 * 1024;

export class Refused extends Error {
	override readonly name = "Refused";
}

export interface StreamEvents {
	/** Bytes from the far end. Give them back with `consumed` once they are gone, or no more come. */
	data(bytes: Uint8Array): void;
	/** The far end sends no more. */
	end(): void;
	/** Bytes written earlier are on their way, and `buffered` went down. */
	drain(): void;
	/** Once, and last. Null when both ends ended it. */
	close(error: Error | null): void;
}

export interface Stream {
	/** What the far end said when it opened it. */
	readonly answer: unknown;
	/** Bytes written that wait for the far end to take more. */
	readonly buffered: number;
	listen(events: StreamEvents): void;
	write(bytes: Uint8Array): void;
	end(): void;
	reset(): void;
	consumed(bytes: number): void;
}

/** A stream the far end asks for. One of the two, once. */
export interface Asked {
	readonly to: unknown;
	accept(answer?: unknown): Stream;
	refuse(reason: string): void;
}

export interface MuxOptions {
	readonly dialled: boolean;
	/** The bytes are the channel's from here on. */
	send(message: Uint8Array<ArrayBuffer>): void;
	asked(asked: Asked): void;
}

const text = new TextEncoder();
const untext = new TextDecoder();

function message(type: number, id: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(HEAD + payload.length);
	out[0] = type;
	new DataView(out.buffer).setUint32(1, id, true);
	out.set(payload, HEAD);
	return out;
}

const NOTHING = new Uint8Array();
const json = (value: unknown) => text.encode(JSON.stringify(value ?? null));

class MuxStream implements Stream {
	answer: unknown = null;
	readonly #post: (type: number, payload?: Uint8Array) => void;
	readonly #gone: () => void;
	#events: StreamEvents | undefined;
	/** What came before anyone listened. */
	#early: ((events: StreamEvents) => void)[] = [];
	#out: Uint8Array[] = [];
	#buffered = 0;
	#credit = WINDOW;
	#unsaid = 0;
	#ending = false;
	#ended = false;
	#farEnded = false;
	#over = false;

	constructor(post: (type: number, payload?: Uint8Array) => void, gone: () => void) {
		this.#post = post;
		this.#gone = gone;
	}

	get buffered(): number {
		return this.#buffered;
	}

	listen(events: StreamEvents): void {
		this.#events = events;
		for (const fire of this.#early.splice(0)) fire(events);
	}

	#fire(event: (events: StreamEvents) => void): void {
		if (this.#events) event(this.#events);
		else this.#early.push(event);
	}

	write(bytes: Uint8Array): void {
		if (this.#over || this.#ending || bytes.length === 0) return;
		this.#out.push(bytes.slice());
		this.#buffered += bytes.length;
		this.#pump();
	}

	end(): void {
		if (this.#over || this.#ending) return;
		this.#ending = true;
		this.#pump();
	}

	reset(): void {
		if (this.#over) return;
		this.#post(RESET);
		this.#finish();
	}

	consumed(bytes: number): void {
		if (this.#over || this.#farEnded) return;
		this.#unsaid += bytes;
		if (this.#unsaid < WINDOW / 4) return;
		const said = new Uint8Array(4);
		new DataView(said.buffer).setUint32(0, this.#unsaid, true);
		this.#unsaid = 0;
		this.#post(CREDIT, said);
	}

	#pump(): void {
		const before = this.#buffered;
		for (let next = this.#out[0]; next && this.#credit > 0; next = this.#out[0]) {
			const n = Math.min(next.length, this.#credit, CHUNK);
			this.#post(DATA, next.subarray(0, n));
			if (n === next.length) this.#out.shift();
			else this.#out[0] = next.subarray(n);
			this.#credit -= n;
			this.#buffered -= n;
		}
		if (this.#ending && !this.#ended && this.#buffered === 0) {
			this.#ended = true;
			this.#post(END);
			if (this.#farEnded) this.close(null);
			return;
		}
		if (this.#buffered < before) this.#fire((on) => on.drain());
	}

	/** From the far end. */
	receive(type: number, payload: Uint8Array): void {
		if (this.#over) return;
		switch (type) {
			case DATA: {
				const bytes = payload.slice();
				this.#fire((on) => on.data(bytes));
				return;
			}
			case CREDIT:
				this.#credit += new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
				this.#pump();
				return;
			case END:
				if (this.#farEnded) return;
				this.#farEnded = true;
				this.#fire((on) => on.end());
				if (this.#ended) this.close(null);
				return;
			case RESET:
				this.close(new Error("The far end dropped the connection."));
				return;
		}
	}

	close(error: Error | null): void {
		if (this.#over) return;
		this.#finish();
		this.#fire((on) => on.close(error));
	}

	#finish(): void {
		this.#over = true;
		this.#out = [];
		this.#buffered = 0;
		this.#gone();
	}
}

export class Mux {
	readonly #options: MuxOptions;
	readonly #streams = new Map<number, MuxStream>();
	readonly #opening = new Map<number, { resolve(stream: Stream): void; reject(error: Error): void }>();
	#next: number;
	#closed = false;

	constructor(options: MuxOptions) {
		this.#options = options;
		this.#next = options.dialled ? 1 : 2;
	}

	/** Rejects with a Refused, or with an Error when the channel closes first. Aborting drops what it asked for. */
	open(to: unknown, signal?: AbortSignal): Promise<Stream> {
		if (this.#closed) return Promise.reject(new Error("The link is closed."));
		if (signal?.aborted) return Promise.reject(signal.reason);
		const id = this.#next;
		this.#next += 2;
		const opening = Promise.withResolvers<Stream>();
		const abort = () => {
			if (!this.#opening.delete(id)) return;
			this.#post(id, RESET);
			opening.reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const settled = () => signal?.removeEventListener("abort", abort);
		this.#opening.set(id, {
			resolve(stream) {
				settled();
				opening.resolve(stream);
			},
			reject(error) {
				settled();
				opening.reject(error);
			},
		});
		this.#post(id, OPEN, json(to));
		return opening.promise;
	}

	receive(bytes: Uint8Array): void {
		if (this.#closed || bytes.length < HEAD) return;
		const type = bytes[0];
		const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
		const payload = bytes.subarray(HEAD);
		if (type === OPEN) this.#asked(id, payload);
		else if (type === OPENED) this.#opened(id, payload);
		else if (type === REFUSED) {
			const opening = this.#opening.get(id);
			this.#opening.delete(id);
			opening?.reject(new Refused(untext.decode(payload)));
		} else this.#streams.get(id)?.receive(type, payload);
	}

	/** The channel is gone, and every stream with it. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const error = new Error("The link closed.");
		for (const opening of this.#opening.values()) opening.reject(error);
		this.#opening.clear();
		for (const stream of [...this.#streams.values()]) stream.close(error);
	}

	#post(id: number, type: number, payload: Uint8Array = NOTHING): void {
		if (!this.#closed) this.#options.send(message(type, id, payload));
	}

	#add(id: number): MuxStream {
		const stream = new MuxStream(
			(type, payload) => this.#post(id, type, payload),
			() => this.#streams.delete(id),
		);
		this.#streams.set(id, stream);
		return stream;
	}

	#opened(id: number, payload: Uint8Array): void {
		const opening = this.#opening.get(id);
		// One that was given up meanwhile was reset then.
		if (!opening) return;
		this.#opening.delete(id);
		const stream = this.#add(id);
		stream.answer = JSON.parse(untext.decode(payload));
		opening.resolve(stream);
	}

	#asked(id: number, payload: Uint8Array): void {
		// Held from now, so that a reset that comes before the answer is heard.
		const stream = this.#add(id);
		this.#options.asked({
			to: JSON.parse(untext.decode(payload)),
			accept: (answer) => {
				stream.answer = answer;
				this.#post(id, OPENED, json(answer));
				return stream;
			},
			refuse: (reason) => {
				this.#streams.delete(id);
				this.#post(id, REFUSED, text.encode(reason));
			},
		});
	}
}
