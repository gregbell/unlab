// Proves the lab network: two unkernel machines, each in its own thread,
// bridged by the layer-2 switch, reach each other with ARP, ICMP and TCP.
import assert from "node:assert/strict";
import { test } from "vitest";
import { arpAddrs, dstMac, IP_ICMP, IP_TCP, ipAddrs, macStr, nodeMac } from "../../src/net/index.ts";
import { bootLab } from "./lab.ts";

const NODE2_MAC = macStr(nodeMac(2));

test("two machines share one layer-2 segment", async () => {
	const lab = await bootLab([
		{ n: 1, ports: [1] },
		{ n: 2, ports: [2] },
	]);
	const { sw, frames } = lab;
	const [node1, node2] = lab.machines;
	try {
		assert.match(await node1.run("ip -4 -o addr show eth0"), /10\.88\.0\.11/, "node1 should hold its lab address");

		// ICMP across the switch: ARP resolution then echo request/reply.
		const ping = await node1.run("ping -c 3 -W 2 node2");
		assert.match(ping, /3 packets transmitted, 3 (packets )?received/);

		// The guests' own ARP tables, resolved over the switch.
		assert.match(await node1.run("ip neigh show"), /10\.88\.0\.12/);

		// Real TCP between the two kernels.
		void node2.exec("printf 'hello-from-node2\\n' | nc -l -p 9000 -w 10");
		await new Promise((r) => setTimeout(r, 1500));
		assert.match(await node1.run("nc -w 5 10.88.0.12 9000"), /hello-from-node2/);

		assert.ok(
			frames.some((e) => arpAddrs(e.frame)),
			"the switch should have seen ARP",
		);
		for (const proto of [IP_ICMP, IP_TCP]) {
			assert.ok(
				frames.some((e) => ipAddrs(e.frame)?.proto === proto),
				`the switch should have seen IP protocol ${proto}`,
			);
		}

		const entry = () => sw.macTable().find((e) => e.mac === NODE2_MAC);
		const unknown = () => frames.filter((e) => e.from === 1 && e.flood === "unknown" && dstMac(e.frame) === NODE2_MAC);
		sw.setLink(2, false);
		assert.deepEqual(
			{ port: entry()?.port, flushed: entry()?.flushed },
			{ port: 2, flushed: true },
			"a cut keeps node2's entry, flushed",
		);
		const floodsBeforeCut = unknown().length;
		const cutPing = await node1.exec("ping -c 1 -W 1 10.88.0.12");
		assert.notEqual(cutPing.exitCode, 0, "a ping across a cut cable should fail");
		assert.ok(unknown().length > floodsBeforeCut, "frames for node2 should flood as an unknown destination");

		sw.setLink(2, true);
		await node1.run("ping -c 2 -W 2 10.88.0.12");
		assert.equal(entry()?.flushed, false, "node2's address is relearned on port 2");
	} finally {
		await lab.stop();
	}
});
