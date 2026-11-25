import { expect, test, vi } from "vitest";
import { type Asked, Mux, Refused, type Stream, type StreamEvents, WINDOW } from "./mux.ts";

/** Two ends, with every message delivered in its own turn as a socket would. */
function pair(asked: (asked: Asked) => void) {
	const dialler: Mux = new Mux({
		dialled: true,
		send: (m) => queueMicrotask(() => listener.receive(m)),
		asked: () => {},
	});
	const listener: Mux = new Mux({ dialled: false, send: (m) => queueMicrotask(() => dialler.receive(m)), asked });
	return { dialler, listener };
}

function collect(stream: Stream, events: Partial<StreamEvents> = {}) {
	const got = { bytes: 0, ended: false, closed: undefined as Error | null | undefined };
	stream.listen({
		data(bytes) {
			got.bytes += bytes.length;
			stream.consumed(bytes.length);
		},
		end() {
			got.ended = true;
		},
		drain() {},
		close(error) {
			got.closed = error;
		},
		...events,
	});
	return got;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a stream carries far more than its window, and each end can stop sending before the other", async () => {
	let far: Stream | undefined;
	const { dialler } = pair((asked) => {
		far = asked.accept({ hello: asked.to });
	});
	const near = await dialler.open({ kind: "port", port: 80 });
	expect(near.answer).toEqual({ hello: { kind: "port", port: 80 } });
	const atFar = collect(far as Stream);
	const atNear = collect(near);

	near.write(new Uint8Array(WINDOW * 5));
	near.end();
	await vi.waitFor(() => expect(atFar).toMatchObject({ bytes: WINDOW * 5, ended: true, closed: undefined }));

	far?.write(new Uint8Array(1000));
	far?.end();
	await vi.waitFor(() => expect(atNear).toMatchObject({ bytes: 1000, ended: true, closed: null }));
	expect(atFar.closed).toBeNull();
});

test("a reader that takes nothing holds its own writer up, and no other stream", async () => {
	const streams: Stream[] = [];
	const { dialler } = pair((asked) => streams.push(asked.accept()));
	const slow = await dialler.open("slow");
	const quick = await dialler.open("quick");
	let held = 0;
	collect(streams[0], { data: (bytes) => (held += bytes.length) });
	const atQuick = collect(streams[1]);
	slow.write(new Uint8Array(WINDOW * 2));
	quick.write(new Uint8Array(WINDOW * 2));
	await vi.waitFor(() => expect(atQuick.bytes).toBe(WINDOW * 2));
	expect(held).toBe(WINDOW);
	expect(slow.buffered).toBe(WINDOW);
	streams[0].consumed(WINDOW);
	await vi.waitFor(() => expect(held).toBe(WINDOW * 2));
	expect(slow.buffered).toBe(0);
});

test("a refusal says why, and a channel that closes ends what is open and what is asked for", async () => {
	const asks: Asked[] = [];
	const { dialler, listener } = pair((asked) => asks.push(asked));
	const refused = dialler.open("no");
	await settle();
	asks[0].refuse("node2 is off.");
	await expect(refused).rejects.toEqual(new Refused("node2 is off."));

	const opening = dialler.open("yes");
	await settle();
	const far = collect(asks[1].accept());
	const near = collect(await opening);
	const waiting = dialler.open("never answered");
	dialler.close();
	listener.close();
	await expect(waiting).rejects.toThrow("The link closed.");
	expect(near.closed).toBeInstanceOf(Error);
	expect(far.closed).toBeInstanceOf(Error);
	await expect(dialler.open("late")).rejects.toThrow("The link is closed.");
});

test("what is given up before it is answered is dropped at the far end", async () => {
	const asks: Asked[] = [];
	const { dialler } = pair((asked) => asks.push(asked));
	const giveUp = new AbortController();
	const opening = dialler.open("slow", giveUp.signal);
	await settle();
	giveUp.abort(new Error("Cancelled."));
	await expect(opening).rejects.toThrow("Cancelled.");
	await settle();
	const far = collect(asks[0].accept());
	expect(far.closed).toBeInstanceOf(Error);
});

test("bytes that come before anyone listens are kept in order", async () => {
	let far: Stream | undefined;
	const { dialler } = pair((asked) => {
		far = asked.accept();
	});
	const near = await dialler.open("x");
	near.write(Uint8Array.of(1));
	near.write(Uint8Array.of(2));
	near.end();
	await settle();
	const seen: string[] = [];
	far?.listen({
		data: (bytes) => seen.push(`data ${[...bytes]}`),
		end: () => seen.push("end"),
		drain() {},
		close: () => seen.push("close"),
	});
	expect(seen).toEqual(["data 1", "data 2", "end"]);
});
