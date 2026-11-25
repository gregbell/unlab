// A machine's end of the link with the CLI: one WebSocket, dialled by the
// machine's own worker, that carries streams both ways. The CLI opens ports in
// the guest, and the guest's gateway opens connections through the CLI.

import type { KernelHandle } from "unkernel";
import { type Asked, Mux, machinePath, type Stream, type ToMachine, WINDOW } from "../streams/index.ts";
import type { GatewayBackend } from "./gateway.ts";
import { type SshPrograms, SshServer } from "./ssh-server.ts";

/** Where the CLI is, and what the page was given to show it. */
export interface LinkTarget {
	/** `ws://127.0.0.1:47122` */
	readonly url: string;
	readonly token: string;
	/** Where the SSH server's programs are fetched from. */
	readonly programs: string;
}

/** As much of a WebSocket as this uses. */
export interface Channel {
	binaryType: BinaryType;
	send(bytes: Uint8Array<ArrayBuffer>): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null;
	onclose: (() => void) | null;
}

export interface MachineLinkOptions {
	readonly n: number;
	readonly name: string;
	readonly gateway: GatewayBackend | undefined;
	dial(url: string): Channel;
	programs(from: string): Promise<SshPrograms>;
}

type Guest = Pick<KernelHandle, "exec" | "connect">;

/** A dropped channel is dialled again this much later, while the page says it is linked. */
const REDIAL_MS = 1000;

function pump(stream: Stream, socket: Awaited<ReturnType<Guest["connect"]>>): void {
	const writer = socket.writable.getWriter();
	let room = Promise.withResolvers<void>();
	let over = false;
	const drop = () => {
		if (over) return;
		over = true;
		room.resolve();
		socket.close();
	};
	stream.listen({
		data(bytes) {
			writer.write(bytes).then(
				() => stream.consumed(bytes.length),
				() => stream.reset(),
			);
		},
		end: () => void writer.close().catch(() => {}),
		drain() {
			room.resolve();
			room = Promise.withResolvers();
		},
		// The guest's own end is closed by then when both have ended.
		close: (error) => (error ? drop() : room.resolve()),
	});
	void (async () => {
		try {
			for (const reader = socket.readable.getReader(); !over; ) {
				const { done, value } = await reader.read();
				if (done) break;
				stream.write(value);
				while (stream.buffered > WINDOW && !over) await room.promise;
			}
			stream.end();
		} catch {
			stream.reset();
			drop();
		}
	})();
}

export class MachineLink {
	readonly #options: MachineLinkOptions;
	#target: LinkTarget | null = null;
	#channel: Channel | undefined;
	#guest: PromiseWithResolvers<Guest> = Promise.withResolvers();
	#ssh: SshServer | undefined;

	constructor(options: MachineLinkOptions) {
		this.#options = options;
	}

	/** The guest is set up and takes connections. */
	ready(guest: Guest): void {
		this.#ssh = new SshServer(guest, () => this.#options.programs(this.#target?.programs ?? ""));
		this.#guest.resolve(guest);
	}

	/** Null when the page is not linked. */
	link(target: LinkTarget | null): void {
		if (target?.url === this.#target?.url && target?.token === this.#target?.token) return;
		this.#target = target;
		this.#channel?.close();
		this.#dial();
	}

	#dial(): void {
		const target = this.#target;
		if (!target || this.#channel) return;
		const { n, name, gateway } = this.#options;
		const channel = this.#options.dial(target.url + machinePath(target.token, n, name));
		channel.binaryType = "arraybuffer";
		this.#channel = channel;
		const mux = new Mux({
			dialled: true,
			send: (message) => channel.send(message),
			asked: (asked) => void this.#asked(asked),
		});
		channel.onopen = () => gateway?.relay(mux);
		channel.onmessage = ({ data }) => mux.receive(new Uint8Array(data));
		channel.onclose = () => {
			this.#channel = undefined;
			gateway?.relay(undefined);
			mux.close();
			if (this.#target !== target) this.#dial();
			else setTimeout(() => this.#dial(), REDIAL_MS);
		};
	}

	async #asked(asked: Asked): Promise<void> {
		const to = asked.to as ToMachine;
		try {
			const guest = await this.#guest.promise;
			const socket = await (to.kind === "ssh" ? this.#sshSocket(guest, to) : guest.connect(to.port));
			pump(asked.accept(), socket);
		} catch (error) {
			asked.refuse(error instanceof Error ? error.message : String(error));
		}
	}

	async #sshSocket(guest: Guest, { keys }: Extract<ToMachine, { kind: "ssh" }>) {
		const server = this.#ssh as SshServer;
		try {
			return await guest.connect(await server.port(keys));
		} catch {
			// Someone ended it, so it is started again.
			server.lost();
			return guest.connect(await server.port(keys));
		}
	}
}
