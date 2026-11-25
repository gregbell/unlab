// Ports on this computer that lead to ports in machines.

import { createServer, type Server, type Socket } from "node:net";
import type { LinkedMachine, Stream } from "../../src/streams/index.ts";
import { joinSocket } from "./relay.ts";

interface Forward {
	readonly machine: string;
	readonly local: number;
	readonly remote: number;
	readonly server: Server;
	readonly sockets: Set<Socket>;
}

export class Forwards {
	readonly #open: (machine: string, port: number) => Promise<Stream>;
	readonly #forwards = new Map<number, Forward>();

	constructor(open: (machine: string, port: number) => Promise<Stream>) {
		this.#open = open;
	}

	list(): { machine: string; local: number; remote: number }[] {
		return [...this.#forwards.values()].map(({ machine, local, remote }) => ({ machine, local, remote }));
	}

	/** Rejects with a sentence. */
	async add(machine: string, local: number, remote: number, machines: readonly LinkedMachine[]): Promise<void> {
		if (!machines.some((m) => m.name === machine)) {
			const names = machines.map((m) => m.name);
			throw new Error(
				`No machine called ${machine}. ${names.length === 0 ? "The lab has none yet." : `You have ${names.join(", ")}.`}`,
			);
		}
		const taken = this.#forwards.get(local);
		if (taken) throw new Error(`Port ${local} already leads to ${taken.machine}:${taken.remote}. Choose another.`);
		const sockets = new Set<Socket>();
		const server = createServer({ allowHalfOpen: true, noDelay: true, pauseOnConnect: true }, (socket) => {
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.on("error", () => socket.destroy());
			this.#open(machine, remote).then(
				(stream) => {
					joinSocket(socket, stream);
					socket.resume();
				},
				() => socket.resetAndDestroy(),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code === "EADDRINUSE") {
					reject(new Error(`Port ${local} is taken on this computer. Choose another.`));
				} else if (error.code === "EACCES") {
					reject(new Error(`Port ${local} needs more rights than you have on this computer. Choose one from 1024 up.`));
				} else reject(error);
			});
			server.listen(local, "127.0.0.1", resolve);
		});
		this.#forwards.set(local, { machine, local, remote, server, sockets });
	}

	remove(local: number): void {
		const forward = this.#forwards.get(local);
		if (!forward) throw new Error(`Port ${local} is not forwarded.`);
		this.#end(forward);
	}

	/** End those of machines that are gone. */
	keep(there: (machine: string) => boolean): void {
		for (const forward of [...this.#forwards.values()]) if (!there(forward.machine)) this.#end(forward);
	}

	close(): void {
		for (const forward of [...this.#forwards.values()]) this.#end(forward);
	}

	#end({ local, server, sockets }: Forward): void {
		this.#forwards.delete(local);
		server.close();
		for (const socket of sockets) socket.destroy();
	}
}
