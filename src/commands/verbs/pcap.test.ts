import { describe, expect, it } from "vitest";
import { NAMES, ping } from "../../../test/support/frames.ts";
import type { PortNo } from "../../model/index.ts";
import { type CapturedFrame, PCAP_TYPE } from "../../net/index.ts";
import { storeLab } from "../testing/store.ts";
import { MAX_PCAP_BYTES, type PcapData } from "./pcap.ts";

const carried = (on: string, bytes: Uint8Array, t: number, from = 1 as PortNo, to = 2 as PortNo): CapturedFrame => ({
	switch: on,
	from,
	to: 1 << (to - 1),
	bytes,
	names: NAMES,
	vlan: 1,
	tagged: 0,
	t,
});

/** A lab with switch0 and lan, where switch0 carried two pings and lan one. */
async function twoSwitches() {
	const lab = storeLab();
	await lab.run("mkswitch lan");
	lab.captured.push(
		carried("switch0", ping(1, 2, 1), 1000),
		carried("lan", ping(3, 4, 1), 1500),
		carried("switch0", ping(1, 2, 2), 2000),
	);
	return lab;
}

/** A .pcap's frames: each record's bytes, in order. */
function records(file: Uint8Array): Uint8Array[] {
	const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const out: Uint8Array[] = [];
	for (let at = 24; at < file.length; at += 16 + view.getUint32(at + 8, true)) {
		out.push(file.subarray(at + 16, at + 16 + view.getUint32(at + 8, true)));
	}
	return out;
}

const decoded = (data: unknown) => Uint8Array.from(atob(String((data as PcapData).bytes)), (c) => c.charCodeAt(0));

describe("pcap", () => {
	it("downloads the file for a person, and gives an agent the same bytes in base64", async () => {
		const lab = await twoSwitches();
		const typed = await lab.run("pcap switch0:1");
		expect(typed).toEqual({
			kind: "visible",
			text: "saved unlab-switch0-port1.pcap to downloads · 2 frames",
			data: { name: "unlab-switch0-port1.pcap", frames: 2, size: 24 + 2 * (16 + ping(1, 2).length) },
		});
		expect(lab.downloads.map(({ name, type }) => [name, type])).toEqual([["unlab-switch0-port1.pcap", PCAP_TYPE]]);
		const [{ bytes }] = lab.downloads;
		expect(records(bytes)).toEqual([ping(1, 2, 1), ping(1, 2, 2)]);

		const called = await lab.run("pcap switch0:1", "agent");
		expect(called).toMatchObject({ kind: "visible", text: "unlab-switch0-port1.pcap · 2 frames" });
		expect(called.kind === "visible" && decoded(called.data)).toEqual(bytes);
		expect(lab.downloads).toHaveLength(1);
	});

	it("saves what a switch or a cable shows, and every frame for a filter that names neither", async () => {
		const lab = await twoSwitches();
		const saved = async (line: string) => {
			const result = await lab.run(line, "agent");
			if (result.kind !== "visible") throw new Error(`${line} failed`);
			return { name: (result.data as PcapData).name, frames: records(decoded(result.data)) };
		};
		const all = [ping(1, 2, 1), ping(3, 4, 1), ping(1, 2, 2)];
		expect(await saved("pcap lan")).toEqual({ name: "unlab-lan.pcap", frames: [ping(3, 4, 1)] });
		expect(await saved("pcap switch0 icmp")).toEqual({ name: "unlab-filtered.pcap", frames: [all[0], all[2]] });
		expect(await saved("pcap")).toEqual({ name: "unlab.pcap", frames: all });
		expect(await saved("pcap node3")).toEqual({ name: "unlab.pcap", frames: all });
	});

	it("refuses an agent a file past what it returns, and says how to narrow it, while a person still gets it", async () => {
		const lab = storeLab();
		const big = new Uint8Array(1500);
		big.set(ping(1, 2));
		const frames = Math.ceil(MAX_PCAP_BYTES / (16 + big.length));
		for (let i = 0; i < frames; i++) lab.captured.push(carried("switch0", big, i));
		const called = await lab.run("pcap", "agent");
		expect(called).toEqual({
			kind: "failed",
			error: {
				message: `unlab-switch0.pcap would hold ${frames} frames, more than fit in the 2 MiB that capture_save returns, so narrow the filter, such as to switch0:1. Nothing was changed.`,
			},
		});
		expect(lab.store.state.log.at(-1)).toMatchObject({ line: "pcap", source: "agent", outcome: "failed" });
		expect(await lab.run("pcap")).toMatchObject({ kind: "visible", data: { frames } });
		expect(lab.downloads[0]?.bytes.length).toBeGreaterThan(MAX_PCAP_BYTES);
	});
});
