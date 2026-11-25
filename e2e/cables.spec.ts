import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { crash, root, shell, typed } from "./lab.ts";
import { call } from "./webmcp.ts";

/** When set, the tests also save screenshots of cables that were moved there. */
const shots = process.env.UI_SHOTS;

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

interface Topology {
	readonly switches: readonly {
		readonly name: string;
		readonly ports: readonly {
			readonly port: number;
			readonly cable: { readonly to: { machine: string; nic: string }; readonly link: string } | null;
		}[];
	}[];
	readonly unplugged: readonly { readonly machine: string; readonly nic: string }[];
}
interface Row {
	readonly switch?: string;
	readonly from: { readonly name?: string; readonly nic?: string };
	readonly to: { readonly name?: string; readonly nic?: string };
	readonly info: string;
}

async function openLab(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
	return errors;
}

const status = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 90_000 });
const bar = (page: Page) => page.locator("unlab-command-bar");
const dock = (page: Page) => page.locator("unlab-capture[mode=dock]");

/** `lan: 1 node2:eth0 up, 2 node3:eth0 cut` for each switch, and the NICs that are in none. */
async function wiring(page: Page): Promise<string[]> {
	const { switches, unplugged } = ((await call(page, "topology_read", {})) as { data: Topology }).data;
	const listed = switches.map(({ name, ports }) => {
		const held = ports.flatMap(({ port, cable }) =>
			cable ? [`${port} ${cable.to.machine}:${cable.to.nic} ${cable.link}`] : [],
		);
		return `${name}: ${held.join(", ")}`;
	});
	const loose = unplugged.map(({ machine, nic }) => `${machine}:${nic}`);
	return loose.length === 0 ? listed : [...listed, `unplugged: ${loose.join(", ")}`];
}

const reaches = async (page: Page, machine: number | string, address: string) =>
	(await shell(page, machine, `ping -c 1 -W 1 ${address}`)).exitCode === 0;

/** The machines that the switch has learned, on its panel. */
async function learned(page: Page, on: string): Promise<string[]> {
	await page.getByRole("button", { name: "Maximise switches" }).click();
	await page.locator("unlab-switch").getByRole("combobox", { name: "Switch" }).selectOption(on);
	await expect(page.locator("unlab-mac-table").getByRole("heading")).toHaveText(`${on} mac address table`);
	const names = await page.locator("unlab-mac-table tbody .machine").allTextContents();
	await page.keyboard.press("Escape");
	return names;
}

/** What its machine would lose if it stopped. */
const life = (page: Page, machine: number) =>
	root(page, machine, "cat /proc/sys/kernel/random/boot_id; pidof sleep; ls /run/kept");

test("a cable moves to another switch, at its lowest free port or one that is named, and the machine runs on", async ({
	page,
}) => {
	const errors = await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 2 alpine --no-gateway");
	await status(page, "2 of 2 ready");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await status(page, "3 of 3 ready");
	await root(page, 1, "nohup sleep 9999 > /dev/null 2>&1 < /dev/null & touch /run/kept");
	const before = await life(page, 1);
	expect(await reaches(page, 1, "node2")).toBe(true);
	expect(await reaches(page, 1, "node3")).toBe(false);
	expect(await learned(page, "switch0")).toEqual(["node1", "node2"]);

	// By a person, without naming the port.
	await typed(page, "plug node1 lan");
	await expect(dock(page)).toContainText("switch0 port 1 link down. Cable to node1 unplugged by you.");
	await expect(dock(page)).toContainText("lan port 2 link up. Cable to node1 plugged in by you.");
	expect(await wiring(page)).toEqual(["switch0: 2 node2:eth0 up", "lan: 1 node3:eth0 up, 2 node1:eth0 up"]);
	expect(await learned(page, "switch0")).toEqual(["node2"]);
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(await reaches(page, 1, "node2")).toBe(false);
	expect(await life(page, 1)).toBe(before);

	// By an agent, to a port by name, on the same switch.
	const there = { machine: "node1", nic: "eth0", switch: "lan", port: 7, link: "up" };
	expect(await call(page, "cable_plug", { nic: "node1:eth0", to: "lan:7" })).toEqual({
		result: "node1 plugged into lan port 7 · up",
		data: there,
	});
	expect((await wiring(page))[1]).toBe("lan: 1 node3:eth0 up, 7 node1:eth0 up");
	expect(await reaches(page, 3, "node1")).toBe(true);
	expect(await learned(page, "lan")).toEqual(expect.arrayContaining(["node1", "node3"]));

	// Where it is already, nothing changes: what the switch has learned, and what the capture says.
	for (const to of ["lan", "lan:7"]) {
		expect(await call(page, "cable_plug", { nic: "node1", to })).toEqual({
			result: "node1 already in lan port 7 · up",
			data: there,
		});
	}
	expect(await learned(page, "lan")).toEqual(expect.arrayContaining(["node1", "node3"]));

	// A cut cable moves as it is.
	await typed(page, "link down node1");
	await expect(dock(page)).toContainText("lan port 7 link down. Cable to node1 cut by you.");
	await expect(dock(page)).not.toContainText("lan port 7 link down. Cable to node1 unplugged");
	expect(await call(page, "cable_plug", { nic: "node1", to: "switch0:8" })).toMatchObject({
		result: "node1 plugged into switch0 port 8 · cut",
		data: { link: "cut" },
	});
	expect((await wiring(page))[0]).toBe("switch0: 2 node2:eth0 up, 8 node1:eth0 cut");
	expect(await reaches(page, 1, "node2")).toBe(false);
	await typed(page, "link up node1");
	expect(await reaches(page, 1, "node2")).toBe(true);
	if (shots) await page.screenshot({ path: `${shots}/moved-cable.png` });

	// Unplugged, it takes no port and reaches no one.
	expect(await call(page, "cable_unplug", { nic: "node1" })).toEqual({
		result: "node1 unplugged",
		data: { machine: "node1", nic: "eth0", port: null, link: "unplugged" },
	});
	expect(await wiring(page)).toEqual(["switch0: 2 node2:eth0 up", "lan: 1 node3:eth0 up", "unplugged: node1:eth0"]);
	expect(await reaches(page, 1, "node2")).toBe(false);
	await typed(page, "plug node1 lan:4");
	expect(await reaches(page, 1, "node3")).toBe(true);
	expect(await life(page, 1)).toBe(before);
	await status(page, "3 of 3 ready");
	expect(errors).toEqual([]);
});

test("a moved or unplugged cable is where a reload, a reboot, a restore and a boot after a failure find it", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 3 alpine --no-gateway");
	await status(page, "3 of 3 ready");
	expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" })).not.toHaveProperty("error");
	await typed(page, "plug node1 lan:4");
	await typed(page, "plug node2 lan:6");
	await typed(page, "unplug node3");
	const moved = ["switch0: ", "lan: 4 node1:eth0 up, 6 node2:eth0 up", "unplugged: node3:eth0"];
	expect(await wiring(page)).toEqual(moved);

	await page.reload();
	await status(page, "3 of 3 ready");
	expect(await wiring(page)).toEqual(moved);
	expect(await reaches(page, 1, "node2")).toBe(true);

	expect(await call(page, "machines_reboot", { names: "node1" })).toMatchObject({ data: [{ state: "ready" }] });
	await typed(page, "restore node1 before");
	await bar(page).getByRole("button", { name: "Restore node1" }).click();
	await status(page, "2 of 3 ready");
	await status(page, "3 of 3 ready");
	expect(await wiring(page)).toEqual(moved);
	expect(await reaches(page, 1, "node2")).toBe(true);

	// It gives its port up when it fails, and boots on the switch that the cable was moved to.
	for (const machine of [1, 3]) await crash(page, machine);
	await status(page, "1 of 3 ready, 2 failed");
	await typed(page, "boot node1,node3");
	await status(page, "3 of 3 ready");
	expect(await wiring(page)).toEqual(["switch0: ", "lan: 1 node1:eth0 up, 6 node2:eth0 up", "unplugged: node3:eth0"]);
	expect(await reaches(page, 1, "node2")).toBe(true);
});

test("a NIC that link up plugged in stays plugged in when its machine fails and boots", async ({ page }) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await status(page, "1 of 1 ready");
	await typed(page, "spawn 1 alpine --no-net --no-gateway");
	await status(page, "2 of 2 ready");
	await typed(page, "rmswitch lan");
	await page.keyboard.press("Enter");
	await expect.poll(() => wiring(page)).toEqual(["switch0: ", "unplugged: node1:eth0, node2:eth0"]);
	const back = ["switch0: 1 node1:eth0 up, 2 node2:eth0 up"];
	await typed(page, "link up node1,node2");
	expect(await wiring(page)).toEqual(back);

	for (const machine of [1, 2]) await crash(page, machine);
	await status(page, "0 of 2 ready, 2 failed");
	// A reload before the boot changes nothing of it.
	await page.reload();
	await status(page, "0 of 2 ready, 2 failed");
	await typed(page, "boot node1,node2");
	await status(page, "2 of 2 ready");
	expect(await wiring(page)).toEqual(back);
	expect(await reaches(page, 1, "node2")).toBe(true);
});

test("a machine with a NIC on each of two switches forwards a ping between them, and the capture has it on both", async ({
	page,
}) => {
	const errors = await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --no-gateway --addr 10.1.0.2/24");
	await status(page, "1 of 1 ready");
	await typed(page, "spawn 1 alpine --net lan --no-gateway --addr 10.2.0.2/24");
	await status(page, "2 of 2 ready");
	await typed(page, "spawn 1 alpine --name router --nics 2 --no-gateway --addr 10.1.0.1/24,10.2.0.1/24");
	await status(page, "3 of 3 ready");
	await root(page, 1, "ip route add 10.2.0.0/24 via 10.1.0.1");
	await root(page, 2, "ip route add 10.1.0.0/24 via 10.2.0.1");
	await root(page, "router", "sysctl -w net.ipv4.ip_forward=1");
	// Long enough that the router gives up on node2 and drops the request, rather than send it once it is plugged in.
	expect((await shell(page, 1, "ping -c 1 -W 5 10.2.0.2")).exitCode).toBe(1);

	// The second NIC goes to the other switch while the router runs.
	expect(await call(page, "cable_plug", { nic: "router:eth1", to: "lan" })).toMatchObject({
		data: { switch: "lan", port: 2, link: "up" },
	});
	expect(await wiring(page)).toEqual([
		"switch0: 1 node1:eth0 up, 2 router:eth0 up",
		"lan: 1 node2:eth0 up, 2 router:eth1 up",
	]);
	const from = (await call(page, "capture_read", { filter: "icmp", limit: 1000 })) as { rows: Row[] };
	const ping = await shell(page, 1, "ping -c 3 -W 2 10.2.0.2");
	expect(ping.output).toContain("3 packets transmitted, 3 packets received");

	const { rows } = (await call(page, "capture_read", { filter: "icmp", limit: 1000 })) as { rows: Row[] };
	const name = (end: Row["from"]) => (end.nic ? `${end.name}:${end.nic}` : end.name);
	const hops = rows
		.slice(from.rows.length)
		.map((row) => `${row.switch}: ${name(row.from)} > ${name(row.to)} ${row.info.split(" seq")[0]}`);
	// Each of the three crosses both switches, there and back, in order.
	const one = [
		"switch0: node1 > router:eth0 echo request",
		"lan: router:eth1 > node2 echo request",
		"lan: node2 > router:eth1 echo reply",
		"switch0: router:eth0 > node1 echo reply",
	];
	expect(hops).toEqual([...one, ...one, ...one]);
	if (shots) {
		await typed(page, "capture icmp");
		await page.screenshot({ path: `${shots}/routed-ping.png` });
		await page.keyboard.press("Escape");
	}

	await root(page, "router", "sysctl -w net.ipv4.ip_forward=0");
	expect(await reaches(page, 1, "10.2.0.2")).toBe(false);
	expect(errors).toEqual([]);
});

test("the package gateway works on any switch that eth0 is on, and --no-gateway still leaves it out", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "mkswitch wan");
	await typed(page, "spawn 1 alpine --net lan");
	await status(page, "1 of 1 ready");
	await typed(page, "spawn 1 alpine");
	await status(page, "2 of 2 ready");
	await typed(page, "spawn 1 alpine --net lan --no-gateway");
	await status(page, "3 of 3 ready");
	await typed(page, "spawn 1 alpine --no-net");
	await status(page, "4 of 4 ready");

	const install = async (machine: number, name: string) => {
		await root(page, machine, `apk add --quiet ${name}`);
		expect(await root(page, machine, `apk info -e ${name}`)).toBe(name);
	};
	await install(1, "tree");
	// Moved while it runs.
	await typed(page, "plug node2 wan:5");
	expect((await wiring(page))[2]).toBe("wan: 5 node2:eth0 up");
	await install(2, "tree");
	await page.reload();
	await status(page, "4 of 4 ready");
	expect((await wiring(page))[2]).toBe("wan: 5 node2:eth0 up");
	await install(2, "jq");

	// Left out at spawn, it stays out, wherever the cable is. One spawned on no switch has none either.
	expect(await reaches(page, 1, "node3")).toBe(true);
	await typed(page, "plug node4 lan");
	expect(await reaches(page, 4, "node1")).toBe(true);
	await typed(page, "plug node3 wan");
	const listed = (await call(page, "machines_list", {})) as { data: { gateway: boolean }[] };
	expect(listed.data.map(({ gateway }) => gateway)).toEqual([true, true, false, false]);
	const defaultRoute = (machine: number) => root(page, machine, "ip route | grep ^default || true");
	for (const machine of [3, 4]) {
		expect(await root(page, machine, "ip -4 addr show eth0")).not.toContain("10.0.2.15");
		expect(await defaultRoute(machine)).toBe("");
		expect((await shell(page, machine, "sudo timeout 10 apk add --quiet tree")).exitCode).not.toBe(0);
	}
	expect(await defaultRoute(1)).toContain("dev eth0");
});

test("a full switch, a taken port and all else that cannot be plugged is refused by name", async ({ page }) => {
	await openLab(page);
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --no-gateway");
	await status(page, "1 of 1 ready");
	await typed(page, "spawn 2 alpine --nics 4 --net lan --no-gateway");
	await status(page, "3 of 3 ready");
	const before = await wiring(page);

	const refused = async (nic: string, to: string, sentence: string) => {
		const line = `plug ${nic} ${to}`;
		const said = `${sentence} Nothing was changed.`;
		expect(await call(page, "cable_plug", { nic, to }), line).toEqual({ error: said });
		await typed(page, line);
		const alert = bar(page).getByRole("alert");
		await expect(alert).toBeVisible();
		expect((await alert.locator("p").allTextContents()).join(" "), line).toBe(said);
		await page.keyboard.press("Escape");
	};
	await refused("node1", "lan", "lan has no free port, so use switch0, or free a port with unplug.");
	await refused(
		"node1",
		"lan:6",
		"lan:6 is taken by node3:eth1 and lan has no free port, so use switch0, or free a port with unplug.",
	);
	await refused("node2:eth0", "switch0:1", "switch0:1 is taken by node1, so use switch0:2.");
	for (const to of ["lan:0", "lan:9"]) await refused("node1", to, `${to} is no port, so use one from lan:1 to lan:8.`);
	await refused("node1", "wan:2", "No switch is called wan, so use switch0 or lan.");
	await refused("node1:eth1", "switch0", "node1 has no NIC called eth1, so use eth0.");
	await refused("node9", "lan", "No machine is called node9, so use node1, node2 or node3.");
	expect(await call(page, "machines_spawn", { count: 1, image: "alpine", nics: 2, net: "switch0,wan" })).toEqual({
		error: "spawn wants switch0, lan or none after --net, not wan. Nothing was changed.",
	});
	expect(await wiring(page)).toEqual(before);

	// A machine that takes no change: one that boots, one that has failed.
	await typed(page, "spawn 1 alpine --no-net --no-gateway");
	await status(page, "3 of 4 ready, 1 booting");
	expect(await call(page, "cable_plug", { nic: "node4", to: "switch0:2" })).toEqual({
		error: "plug wants a ready or off machine here, and node4 is still booting. Nothing was changed.",
	});
	await status(page, "4 of 4 ready");
	await crash(page, 1);
	await status(page, "3 of 4 ready, 1 failed");
	await refused("node1", "switch0:2", "plug wants a ready or off machine here, and node1 has failed.");

	// What the refusal says would work does.
	await typed(page, "boot node1");
	await status(page, "4 of 4 ready");
	await typed(page, "unplug node3:eth1");
	expect(await call(page, "cable_plug", { nic: "node1", to: "lan" })).toMatchObject({
		data: { switch: "lan", port: 6 },
	});
});
