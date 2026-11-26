// Real kernels on ports in VLANs, and on switches that a trunk joins. The
// guests have no 802.1Q: they send and get frames without tags, and the
// switches tag what crosses a trunk.
import assert from "node:assert/strict";
import { test } from "vitest";
import type { PortVlan, VlanId } from "../../src/model/types.ts";
import { vlanTag } from "../../src/net/index.ts";
import { bootLab, type TestLab } from "./lab.ts";

const access = (vlan: number): PortVlan => ({ mode: "access", vlan: vlan as VlanId });
const trunk = (allowed: readonly number[] | "all", native = 1): PortVlan => ({
	mode: "trunk",
	allowed: allowed === "all" ? "all" : (allowed as VlanId[]),
	native: native as VlanId,
});

/** Whether `from` gets an answer from `to`, each machine by its number, all of them in 10.88.0.0/24. */
const pings = async (lab: TestLab, from: number, to: number): Promise<boolean> =>
	(await lab.machines[from - 1].exec(`ping -c 2 -W 1 10.88.0.${10 + to}`)).exitCode === 0;

test("two machines in one subnet but in different VLANs cannot ping each other, and in one VLAN they can, each with frames that have no tag", async () => {
	const lab = await bootLab([
		{ n: 1, ports: [1] },
		{ n: 2, ports: [2] },
	]);
	try {
		lab.sw.setVlan(1, access(10));
		lab.sw.setVlan(2, access(20));
		const apart = lab.frames.length;
		assert.equal(await pings(lab, 1, 2), false, "VLAN 10 does not reach VLAN 20");
		assert.ok(
			lab.frames.slice(apart).every((e) => e.to === 0),
			"what each sent went to no port: the other is in another VLAN",
		);

		lab.sw.setVlan(2, access(10));
		const from = lab.frames.length;
		assert.ok(await pings(lab, 1, 2), "both in VLAN 10, node1 reaches node2");
		assert.ok(await pings(lab, 2, 1), "and node2 reaches node1");
		const carried = lab.frames.slice(from);
		assert.ok(carried.length > 0 && carried.every((e) => e.vlan === 10 && e.tagged === 0), "in VLAN 10, with no tag");
		assert.ok(
			carried.every((e) => vlanTag(e.frame) === null),
			"as the machines sent them",
		);
		assert.deepEqual(
			lab.sw
				.macTable()
				.map((e) => `${e.mac.slice(-2)} vlan ${e.vlan} at ${e.port}`)
				.sort(),
			["0b vlan 10 at 1", "0c vlan 10 at 2"],
			"the switch learns both in VLAN 10",
		);
	} finally {
		await lab.stop();
	}
});

test("two VLANs cross one trunk, tagged, and each machine reaches only those in its own, until the trunk no longer allows one", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 2, ports: [2], on: 0 },
			{ n: 3, ports: [1], on: 1 },
			{ n: 4, ports: [2], on: 1 },
		],
		{ switches: 2, cables: [[0, 8, 1, 8]] },
	);
	try {
		const [a, b] = lab.switches;
		a.setVlan(1, access(10));
		b.setVlan(1, access(10));
		a.setVlan(2, access(20));
		b.setVlan(2, access(20));
		a.setVlan(8, trunk("all"));
		b.setVlan(8, trunk("all"));
		const from = lab.frames.length;
		assert.ok(await pings(lab, 1, 3), "VLAN 10 crosses the trunk");
		assert.ok(await pings(lab, 2, 4), "and so does VLAN 20");
		assert.equal(await pings(lab, 1, 4), false, "but VLAN 10 does not reach VLAN 20 across it");
		assert.equal(await pings(lab, 4, 1), false, "nor VLAN 20 VLAN 10");
		const crossed = lab.frames.slice(from).filter((e) => e.switch === 1 && e.from === 8);
		assert.deepEqual(
			[...new Set(crossed.map((e) => `vlan ${e.vlan}, tagged ${e.tagged === 1 << 7}`))].sort(),
			["vlan 10, tagged true", "vlan 20, tagged true"],
			"what came over the trunk had a tag for its VLAN",
		);

		a.setVlan(8, trunk([10]));
		assert.equal(await pings(lab, 2, 4), false, "a VLAN the trunk does not allow does not cross it");
		assert.ok(await pings(lab, 1, 3), "and the one it allows still does");
	} finally {
		await lab.stop();
	}
});

test("ends of a trunk with different native VLANs move untagged frames from one VLAN to the other, as real switches do", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1], on: 0 },
			{ n: 3, ports: [1], on: 1 },
			{ n: 4, ports: [2], on: 1 },
		],
		{ switches: 2, cables: [[0, 8, 1, 8]] },
	);
	try {
		const [a, b] = lab.switches;
		a.setVlan(1, access(10));
		b.setVlan(1, access(10));
		b.setVlan(2, access(20));
		a.setVlan(8, trunk("all", 10));
		b.setVlan(8, trunk("all", 20));
		assert.ok(await pings(lab, 1, 4), "node1 in VLAN 10 reaches node4 in VLAN 20, untagged on the trunk");
		assert.equal(await pings(lab, 1, 3), false, "and not node3, which is in VLAN 10 at the far end");
		const crossed = lab.frames.filter((e) => e.switch === 1 && e.from === 8);
		assert.ok(
			crossed.length > 0 && crossed.every((e) => e.vlan === 20 && e.tagged === 0),
			"the far switch put what came untagged in its own native VLAN",
		);
	} finally {
		await lab.stop();
	}
});

test("a cable from a port in VLAN 10 to a port in VLAN 20 of one switch joins them, and pings cross it once, with no storm", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1] },
			{ n: 2, ports: [2] },
		],
		{ cables: [[0, 7, 0, 8]] },
	);
	try {
		lab.sw.setVlan(1, access(10));
		lab.sw.setVlan(7, access(10));
		lab.sw.setVlan(2, access(20));
		lab.sw.setVlan(8, access(20));
		assert.ok(await pings(lab, 1, 2), "node1 in VLAN 10 reaches node2 in VLAN 20 over the cable");
		assert.ok(await pings(lab, 2, 1), "and node2 reaches node1");
		assert.deepEqual(
			lab.frames.filter((e) => e.looped).map((e) => `port ${e.from} vlan ${e.vlan}`),
			[],
			"no frame looped",
		);
		assert.deepEqual([lab.storms, lab.sw.storm()], [[], null], "and the switch never stormed");
		assert.ok(
			lab.sw.macTable().some((e) => e.vlan === 20 && e.port === 8),
			"it learned node1 in VLAN 20, behind the cable",
		);
	} finally {
		await lab.stop();
	}
});

test("a broadcast that loops from a trunk into an access port of one switch stays as long as it was sent, its storm ends at a cut, and pings work after it", async () => {
	const lab = await bootLab(
		[
			{ n: 1, ports: [1] },
			{ n: 2, ports: [2] },
		],
		{ cables: [[0, 7, 0, 8]] },
	);
	try {
		lab.sw.setVlan(7, trunk("all"));
		lab.sw.setVlan(8, access(10));
		lab.sw.setVlan(1, access(10));
		lab.sw.setVlan(2, access(10));
		await lab.machines[0].exec("ping -c 1 -W 1 10.88.0.99");
		await new Promise((resolve) => setTimeout(resolve, 2000));
		assert.ok(
			lab.sw.storm(),
			"the switch storms: what leaves by the trunk tagged 10 comes back in by the port of VLAN 10",
		);
		const looped = lab.frames.filter((e) => e.looped);
		const sent = lab.frames.filter((e) => !e.looped && e.from <= 2);
		assert.ok(looped.length > 1000, `the broadcast went round for two seconds: ${looped.length} looped frames`);
		assert.ok(
			Math.max(...looped.map((e) => e.frame.length)) <= Math.max(...sent.map((e) => e.frame.length)),
			"no frame that went round is longer than a machine sent it",
		);

		lab.sw.setLink(7, false);
		const cutAt = lab.now();
		while (lab.sw.storm() && lab.now() - cutAt < 2000) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(lab.sw.storm(), null, "the storm is over once the cable is cut");
		assert.equal(lab.storms.at(-1)?.over, true, "and the switch said so");
		assert.ok(await pings(lab, 1, 2), "node1 reaches node2 again");
		assert.ok(await pings(lab, 2, 1), "and node2 reaches node1");
	} finally {
		await lab.stop();
	}
});
