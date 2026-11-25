// A machine's connections to the internet, opened from this computer. The
// address that is checked is the one that is connected to, so that a public
// name for a private address is refused too.

import { lookup } from "node:dns/promises";
import { connect, isIPv4, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { type Asked, type FromMachine, NO_SUCH_NAME, type Stream, WINDOW } from "../../src/streams/index.ts";

/** Network, prefix length. Loopback, private, link-local, carrier-grade NAT, and what is no one host's. */
const NOT_PUBLIC: readonly (readonly [string, number])[] = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 3],
];

const number = (address: string) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);

export function isPublic(address: string): boolean {
	if (!isIPv4(address)) return false;
	const at = number(address);
	return NOT_PUBLIC.every(([network, bits]) => {
		const size = 2 ** (32 - bits);
		return Math.floor(at / size) !== Math.floor(number(network) / size);
	});
}

/** Services here may listen on every address this computer has, a public one among them. */
function isOwn(address: string): boolean {
	return Object.values(networkInterfaces()).some((all) => all?.some((one) => one.address === address));
}

export interface Connection {
	readonly machine: string;
	readonly host: string;
	readonly port: number;
	/** Bytes to the far end, and back. */
	sent: number;
	received: number;
}

export interface RelayOptions {
	/** Whether machines may reach this computer and its local network. */
	readonly lan: boolean;
	/** The CLI's own port, which no machine may reach whatever else it may. */
	readonly ownPort: () => number;
	/** One is open, with the name the machine looked up for it. */
	readonly opened: (connection: Connection, name: string | null) => void;
}

const CONNECT_MS = 20_000;

export class Relay {
	readonly open = new Set<Connection>();
	readonly #options: RelayOptions;
	/** The names that each machine looked up, by address. */
	readonly #names = new Map<string, string>();

	constructor(options: RelayOptions) {
		this.#options = options;
	}

	async asked(machine: string, asked: Asked): Promise<void> {
		const to = asked.to as FromMachine;
		if (to.kind === "lookup") await this.#lookup(machine, to.name, asked);
		else if (to.kind === "tcp") this.#connect(machine, to.host, to.port, asked);
		else asked.refuse("The CLI does not know how to open that.");
	}

	async #lookup(machine: string, name: string, asked: Asked): Promise<void> {
		try {
			const found = await lookup(name, { family: 4, all: true });
			const addresses = found.map(({ address }) => address);
			for (const address of addresses) this.#names.set(`${machine} ${address}`, name);
			asked.accept(addresses);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			asked.refuse(code === "ENOTFOUND" ? NO_SUCH_NAME : `The name server did not answer: ${code}.`);
		}
	}

	#refusal(host: string, port: number): string | null {
		if (!isIPv4(host)) return `${host} is not an IPv4 address.`;
		if (port === this.#options.ownPort() && (isOwn(host) || !isPublic(host)))
			return `${host}:${port} is the CLI's own.`;
		if (this.#options.lan || (isPublic(host) && !isOwn(host))) return null;
		return `${host} is on this computer or its local network.`;
	}

	#connect(machine: string, host: string, port: number, asked: Asked): void {
		const refusal = this.#refusal(host, port);
		if (refusal !== null) {
			asked.refuse(refusal);
			return;
		}
		const socket = connect({ host, port, allowHalfOpen: true, noDelay: true });
		socket.setTimeout(CONNECT_MS, () => socket.destroy(new Error("No answer.")));
		const failed = (error: Error) => asked.refuse(error.message);
		socket.once("error", failed);
		socket.once("connect", () => {
			socket.setTimeout(0);
			socket.off("error", failed);
			const connection: Connection = { machine, host, port, sent: 0, received: 0 };
			this.open.add(connection);
			socket.once("close", () => this.open.delete(connection));
			this.#options.opened(connection, this.#names.get(`${machine} ${host}`) ?? null);
			joinSocket(socket, asked.accept(), {
				sent: (n) => {
					connection.sent += n;
				},
				received: (n) => {
					connection.received += n;
				},
			});
		});
	}
}

/** A socket on this computer and a stream, each way, until both have ended. */
export function joinSocket(
	socket: Socket,
	stream: Stream,
	count: { sent(bytes: number): void; received(bytes: number): void } = { sent() {}, received() {} },
): void {
	let over = false;
	stream.listen({
		data(bytes) {
			count.sent(bytes.length);
			socket.write(bytes, () => stream.consumed(bytes.length));
		},
		end: () => socket.end(),
		drain: () => socket.resume(),
		close(error) {
			if (over) return;
			over = true;
			if (error) socket.destroy();
		},
	});
	socket.on("data", (bytes: Buffer) => {
		count.received(bytes.length);
		stream.write(bytes);
		if (stream.buffered > WINDOW) socket.pause();
	});
	socket.on("end", () => stream.end());
	socket.on("error", () => stream.reset());
	socket.on("close", () => {
		// One that ended in order has been ended here too, and has nothing left to say.
		if (!over && !socket.readableEnded) stream.reset();
	});
}
