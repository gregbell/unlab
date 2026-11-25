import { createServer } from "node:net";
import { expect, test } from "vitest";
import type { Asked, Stream } from "../../src/streams/index.ts";
import { isPublic, Relay } from "./relay.ts";

/** What becomes of a machine's connection, as the relay answers it. */
function answer(relay: Relay, host: string, port: number): Promise<string> {
	return new Promise((resolve) => {
		const asked: Asked = {
			to: { kind: "tcp", host, port },
			accept: () => {
				resolve("open");
				const stream: Stream = {
					answer: null,
					buffered: 0,
					listen() {},
					write() {},
					end() {},
					reset() {},
					consumed() {},
				};
				return stream;
			},
			refuse: resolve,
		};
		void relay.asked("node1", asked);
	});
}

test("with --lan a machine reaches this computer, and still not the CLI's own port", async () => {
	const server = createServer().listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const relay = (lan: boolean, ownPort: number) => new Relay({ lan, ownPort: () => ownPort, opened() {} });
	expect(await answer(relay(true, 1), "127.0.0.1", port)).toBe("open");
	expect(await answer(relay(true, port), "127.0.0.1", port)).toBe(`127.0.0.1:${port} is the CLI's own.`);
	expect(await answer(relay(false, 1), "127.0.0.1", port)).toBe("127.0.0.1 is on this computer or its local network.");
	expect(await answer(relay(true, 1), "localhost", port)).toBe("localhost is not an IPv4 address.");
	server.close();
});

test.each([
	"127.0.0.1",
	"127.8.8.8",
	"10.0.0.1",
	"172.16.0.1",
	"172.31.255.255",
	"192.168.1.1",
	"169.254.169.254",
	"100.64.0.1",
	"100.127.255.255",
	"0.0.0.0",
	"224.0.0.1",
	"255.255.255.255",
	"::1",
	"localhost",
	"2130706433",
])("%s is not public", (address) => {
	expect(isPublic(address)).toBe(false);
});

test.each([
	"1.1.1.1",
	"93.184.216.34",
	"172.15.255.255",
	"172.32.0.1",
	"100.63.255.255",
	"100.128.0.1",
	"192.167.0.1",
	"223.255.255.255",
])("%s is public", (address) => {
	expect(isPublic(address)).toBe(true);
});
