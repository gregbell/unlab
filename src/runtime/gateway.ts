// What sits behind a machine's gateway: the package repositories, or while a
// CLI is linked the internet, which the CLI opens from its computer. It changes
// under a running guest, whose address, route and name server stay as they are.

import type { NetBackend, NetConnection, NetConnectionEvents } from "unkernel";
import { type FromMachine, type Mux, NO_SUCH_NAME, Refused, type Stream } from "../streams/index.ts";

function ask(mux: Mux, to: FromMachine, signal?: AbortSignal): Promise<Stream> {
	return mux.open(to, signal);
}

/** One connection of the guest's, through the CLI. The guest is told it is open once the far end has answered. */
class RelayConnection implements NetConnection {
	readonly #giveUp = new AbortController();
	#early: Uint8Array[] = [];
	#earlyBytes = 0;
	#ended = false;
	#stream: Stream | undefined;
	#paused = false;
	#held: Uint8Array[] = [];
	#heldEnd = false;
	#closed: { readonly error: Error | null } | undefined;
	#over = false;
	readonly #on: NetConnectionEvents;

	constructor(mux: Mux, to: { host: string; port: number }, on: NetConnectionEvents) {
		this.#on = on;
		ask(mux, { kind: "tcp", ...to }, this.#giveUp.signal).then(
			(stream) => this.#opened(stream),
			(error: Error) => this.#finish(error),
		);
	}

	#opened(stream: Stream): void {
		if (this.#over) {
			stream.reset();
			return;
		}
		this.#stream = stream;
		this.#on.onConnect();
		stream.listen({
			data: (bytes) => {
				this.#held.push(bytes);
				this.#give();
			},
			end: () => {
				this.#heldEnd = true;
				this.#give();
			},
			drain: () => this.#on.onDrain(),
			close: (error) => {
				this.#closed = { error };
				// What broke is told at once. What ended is told after the bytes before it.
				if (error) this.#finish(error);
				else this.#give();
			},
		});
		for (const bytes of this.#early.splice(0)) stream.write(bytes);
		const waited = this.#earlyBytes;
		this.#earlyBytes = 0;
		if (this.#ended) stream.end();
		if (waited > 0) this.#on.onDrain();
	}

	#give(): void {
		while (!this.#paused && !this.#over) {
			const bytes = this.#held.shift();
			if (!bytes) break;
			this.#on.onData(bytes);
			this.#stream?.consumed(bytes.length);
		}
		if (this.#paused || this.#over || this.#held.length > 0) return;
		if (this.#heldEnd) {
			this.#heldEnd = false;
			this.#on.onEnd();
		}
		if (this.#closed) this.#finish(this.#closed.error);
	}

	#finish(error: Error | null): void {
		if (this.#over) return;
		this.#over = true;
		this.#on.onClose(error);
	}

	write(bytes: Uint8Array): void {
		if (this.#stream) {
			this.#stream.write(bytes);
			return;
		}
		this.#early.push(bytes.slice());
		this.#earlyBytes += bytes.length;
	}

	end(): void {
		this.#ended = true;
		this.#stream?.end();
	}

	destroy(): void {
		if (this.#over) return;
		this.#over = true;
		this.#giveUp.abort(new Error("The guest closed the connection."));
		this.#stream?.reset();
	}

	pause(): void {
		this.#paused = true;
	}

	resume(): void {
		this.#paused = false;
		this.#give();
	}

	get buffered(): number {
		return this.#stream ? this.#stream.buffered : this.#earlyBytes;
	}
}

export class GatewayBackend implements NetBackend {
	readonly #packages: NetBackend;
	#mux: Mux | undefined;

	constructor(packages: NetBackend) {
		this.#packages = packages;
	}

	/** Connections that are open stay with what they were opened through, and end with it. */
	relay(mux: Mux | undefined): void {
		this.#mux = mux;
	}

	connect(to: { host: string; port: number }, on: NetConnectionEvents): NetConnection {
		return this.#mux ? new RelayConnection(this.#mux, to, on) : this.#packages.connect(to, on);
	}

	async lookup(name: string): Promise<string[]> {
		if (!this.#mux) return this.#packages.lookup(name);
		try {
			const stream = await ask(this.#mux, { kind: "lookup", name });
			stream.reset();
			return stream.answer as string[];
		} catch (error) {
			if (error instanceof Refused && error.message === NO_SUCH_NAME) {
				throw Object.assign(new Error(NO_SUCH_NAME), { code: "ENOTFOUND" });
			}
			throw error;
		}
	}

	close(): void {
		this.#packages.close?.();
	}
}
