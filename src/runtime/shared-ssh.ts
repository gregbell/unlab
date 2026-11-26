import type { KernelHandle } from "unkernel";
import { fetchSshPrograms, SshServer } from "./ssh-server.ts";
import type { FromSharedGuest, ToSharedGuest } from "./tailcat-protocol.ts";

type Guest = Pick<KernelHandle, "exec" | "connect">;
type Socket = Awaited<ReturnType<Guest["connect"]>>;
let nextShare = 0;

export function shareGuestSsh(guest: Guest, port: MessagePort): () => void {
	const connections = new Map<
		number,
		{ socket: Socket; writer: WritableStreamDefaultWriter<Uint8Array>; room: PromiseWithResolvers<void> }
	>();
	const pending = new Set<number>();
	let server: SshServer | undefined;
	let listening: Promise<number> | undefined;
	let stopped = false;
	const post = (message: FromSharedGuest) => {
		if (!stopped) port.postMessage(message);
	};
	const close = (id: number) => {
		pending.delete(id);
		const connection = connections.get(id);
		connections.delete(id);
		connection?.room.resolve();
		connection?.socket.close();
	};
	const stop = () => {
		if (stopped) return;
		post({ type: "stop" });
		stopped = true;
		for (const id of connections.keys()) close(id);
		port.close();
		void server?.stop().catch(() => {});
	};
	const open = async (id: number) => {
		if (connections.has(id) || pending.has(id)) return;
		pending.add(id);
		try {
			if (!listening) throw new Error("SSH sharing was not configured.");
			const socket = await guest.connect(await listening);
			if (stopped || !pending.delete(id)) {
				socket.close();
				return;
			}
			const connection = { socket, writer: socket.writable.getWriter(), room: Promise.withResolvers<void>() };
			connections.set(id, connection);
			post({ type: "read", id });
			const reader = socket.readable.getReader();
			while (!stopped && connections.has(id)) {
				const { done, value } = await reader.read();
				if (done) break;
				post({ type: "write", id, data: value });
				await connection.room.promise;
				connection.room = Promise.withResolvers();
			}
		} catch {
			/* The peer sees its connection close. */
		} finally {
			post({ type: "close", id });
			close(id);
		}
	};
	port.onmessage = ({ data: message }: MessageEvent<ToSharedGuest>) => {
		if (stopped) return;
		switch (message.type) {
			case "configure":
				if (server) return;
				server = new SshServer(guest, () => fetchSshPrograms(message.programs), `/run/unlab-tailcat-${++nextShare}`);
				listening = server.port(message.keys);
				void listening
					.then(() => post({ type: "configured" }))
					.catch((error: unknown) => {
						post({ type: "error", message: error instanceof Error ? error.message : String(error) });
						stop();
					});
				return;
			case "open":
				void open(message.id);
				return;
			case "data": {
				const connection = connections.get(message.id);
				if (!connection) return;
				void connection.writer.write(message.data).then(
					() => post({ type: "read", id: message.id }),
					() => {
						post({ type: "close", id: message.id });
						close(message.id);
					},
				);
				return;
			}
			case "written":
				connections.get(message.id)?.room.resolve();
				return;
			case "eof":
				void connections
					.get(message.id)
					?.writer.close()
					.catch(() => close(message.id));
				return;
			case "close":
				close(message.id);
				return;
			case "stop":
				stop();
				return;
		}
	};
	port.start();
	return stop;
}
