import "./capture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { testCapture } from "../../../test/support/capture.ts";
import { arpRequest, ping } from "../../../test/support/frames.ts";
import { isLineError, type PcapData, parseLine, type Result } from "../../commands/index.ts";
import type { Source } from "../../model/index.ts";
import { addSwitch, lab, mount, ready, spawn, switchNamed, unmountAll } from "../base/testing.ts";

beforeEach(() => page.viewport(1440, 900));
afterEach(() => {
	unmountAll();
	vi.restoreAllMocks();
});

const lan = switchNamed("lan");

/** Every file the browser is given to save, by its name, as the bytes it holds. */
function saving() {
	const given: { name: string; bytes: Promise<Uint8Array> }[] = [];
	let last: Blob | null = null;
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
		last = blob instanceof Blob ? blob : null;
		return "blob:unlab-test";
	});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		if (last) given.push({ name: this.download, bytes: last.arrayBuffer().then((b) => new Uint8Array(b)) });
	});
	return async () => {
		const file = given.shift();
		expect(given).toEqual([]);
		if (!file) throw new Error("nothing was saved");
		return { name: file.name, bytes: await file.bytes };
	};
}

describe("pcap and capture_save, beside save .pcap", () => {
	it("give the file that save .pcap gives for the same filter, typed or called", async () => {
		const saved = saving();
		const capture = testCapture();
		const state = lab(spawn(1), ready(), addSwitch(lan));
		capture.switches(state);
		capture.at(1000);
		capture.frame(ping(1, 2, 1), 1, [2]);
		capture.at(1500);
		capture.frame(ping(1, 2, 2), 3, [4], null, lan);
		capture.frame(ping(2, 1, 3, 0), 4, [3], null, lan);
		capture.at(2250);
		capture.frame(ping(1, 2, 4), 5, [4], null, lan);
		capture.frame(arpRequest(1, 2), 3, [4, 5], "group", lan);
		const { store, services, settle } = await mount("unlab-capture", {
			state,
			capture: capture.log,
			prepare: (el) => el.setAttribute("mode", "full"),
		});
		capture.follow(store);
		const run = async (line: string, source: Source): Promise<Result> => {
			const parsed = parseLine(services.commands.registry, line, store.state);
			if (isLineError(parsed) || parsed.danger) throw new Error(`${line} does not run`);
			return parsed.run({ source, signal: new AbortController().signal });
		};

		for (const filter of ["", "arp", "lan", "lan:3", "lan:3 icmp", "lan:5 or switch0", "lan:8"]) {
			await userEvent.fill(page.getByRole("textbox", { name: "filter" }), filter);
			await settle();
			await userEvent.click(page.getByRole("button", { name: "save .pcap" }));
			const button = await saved();

			const typed = await run(`pcap ${filter}`, "bar");
			expect(await saved(), filter).toEqual(button);
			const called = await run(`pcap ${filter}`, "agent");
			if (called.kind !== "visible") throw new Error(`pcap ${filter} failed`);
			const data = called.data as PcapData;
			expect(
				Uint8Array.from(atob(data.bytes ?? ""), (c) => c.charCodeAt(0)),
				filter,
			).toEqual(button.bytes);
			expect([data.name, data.size], filter).toEqual([button.name, button.bytes.length]);
			expect(typed.kind === "visible" && typed.data, filter).toEqual({
				name: data.name,
				frames: data.frames,
				size: data.size,
			});
		}
	});
});
