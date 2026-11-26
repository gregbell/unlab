import "./share-ssh.ts";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { focus, lab, mount, ready, spawn, unmountAll } from "../base/testing.ts";

afterEach(unmountAll);

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEexample user@example";

it("keeps a guest share when its view closes, and stops it on request", async () => {
	let report: ((state: { kind: "ready"; code: string }) => void) | undefined;
	let stops = 0;
	let starts = 0;
	const { element, services, settle } = await mount("unlab-share-ssh", {
		state: lab(spawn(2), ready(), focus("node1")),
		prepare: (view) => {
			view.machine = "node1";
		},
		shareStart: (_machine, _key, onState) => {
			starts++;
			report = onState;
			return { stop: () => stops++ };
		},
	});
	await page.getByRole("button", { name: "Share via SSH" }).click();
	await page.getByRole("textbox", { name: "Their SSH public key" }).fill(KEY);
	await page.getByRole("button", { name: "Start sharing" }).click();
	await expect.element(page.getByRole("button", { name: "Cancel sharing" })).toBeVisible();
	report?.({ kind: "ready", code: "tc123.example" });
	await settle();
	await expect.element(page.getByText("tailcat ssh user@tc123.example")).toBeVisible();
	services.share.start("node1", KEY);
	expect(starts).toBe(1);
	element.machine = "node2";
	await settle();
	await expect.element(page.getByRole("button", { name: "Share via SSH" })).toBeVisible();
	element.machine = "node1";
	await settle();
	await expect.element(page.getByText("tailcat ssh user@tc123.example")).toBeVisible();
	const host = element.parentElement;
	if (!host) throw new Error("Missing test host");
	element.remove();
	const reopened = document.createElement("unlab-share-ssh");
	reopened.machine = "node1";
	host.append(reopened);
	await settle();
	await expect.element(page.getByText("tailcat ssh user@tc123.example")).toBeVisible();
	expect(services.share.state("node1")).toEqual({ kind: "ready", command: "tailcat ssh user@tc123.example" });
	expect(stops).toBe(0);
	await page.getByRole("button", { name: "Stop sharing" }).click();
	expect(stops).toBe(1);
	await expect.element(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
});

it("cancels startup and ignores a late ready result", async () => {
	let report: ((state: { kind: "ready"; code: string }) => void) | undefined;
	let stops = 0;
	const { services, settle } = await mount("unlab-share-ssh", {
		state: lab(spawn(1), ready()),
		prepare: (view) => {
			view.machine = "node1";
		},
		shareStart: (_machine, _key, onState) => {
			report = onState;
			return { stop: () => stops++ };
		},
	});
	await page.getByRole("button", { name: "Share via SSH" }).click();
	await page.getByRole("textbox", { name: "Their SSH public key" }).fill(KEY);
	await page.getByRole("button", { name: "Start sharing" }).click();
	await page.getByRole("button", { name: "Cancel sharing" }).click();
	report?.({ kind: "ready", code: "late.example" });
	await settle();
	expect(stops).toBe(1);
	expect(services.share.state("node1")).toEqual({ kind: "idle" });
	await expect.element(page.getByRole("button", { name: "Start sharing" })).toBeVisible();
});

it("stops sharing when its guest starts powering off", async () => {
	let stops = 0;
	const { store, services, settle } = await mount("unlab-share-ssh", {
		state: lab(spawn(1), ready()),
		prepare: (view) => {
			view.machine = "node1";
		},
		shareStart: () => ({ stop: () => stops++ }),
	});
	await page.getByRole("button", { name: "Share via SSH" }).click();
	await page.getByRole("textbox", { name: "Their SSH public key" }).fill(KEY);
	await page.getByRole("button", { name: "Start sharing" }).click();
	store.dispatchCommand({ type: "cmd/power", machines: ["node1"], next: "off" });
	await settle();
	expect(stops).toBe(1);
	expect(services.share.state("node1")).toEqual({ kind: "idle" });
});

it("enables the idle control when its guest becomes ready", async () => {
	const { store, settle } = await mount("unlab-share-ssh", {
		state: lab(spawn(1)),
		prepare: (view) => {
			view.machine = "node1";
		},
	});
	const open = page.getByRole("button", { name: "Share via SSH" });
	await expect.element(open).toBeDisabled();
	store.dispatchRuntime({ type: "vm/ready", machine: "node1", attempt: 1, bootMs: 3500 });
	await settle();
	await expect.element(open).toBeEnabled();
	store.dispatchCommand({ type: "cmd/power", machines: ["node1"], next: "off" });
	await settle();
	await expect.element(open).toBeDisabled();
});
