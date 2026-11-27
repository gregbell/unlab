import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { typed } from "./lab.ts";
import { call, finish, start } from "./webmcp.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const bar = (page: Page) => page.locator("unlab-command-bar");

/** Closes the bar, from whatever it shows. */
async function closeBar(page: Page): Promise<void> {
	while ((await bar(page).getAttribute("open")) !== null) await page.keyboard.press("Escape");
}

/** The terms that help shows for a line typed in the bar, and what it says of each. */
async function helped(page: Page, line: string): Promise<{ header: string; rows: [string, string][] }> {
	await closeBar(page);
	await typed(page, line);
	await expect(bar(page).locator(".rows")).toBeVisible();
	await expect(bar(page)).toHaveAttribute("open");
	const terms = await bar(page).locator(".rows dt").allTextContents();
	const said = await bar(page).locator(".rows dd").allTextContents();
	const header = (await bar(page).locator(".summary .header").textContent()) ?? "";
	return { header: header.trim(), rows: terms.map((term, i) => [term, said[i]]) };
}

interface Told {
	readonly result: string;
	readonly data: {
		readonly verb: string;
		readonly about: string;
		readonly tool: string | null;
		readonly description: string;
		readonly arguments: readonly { field: string; written: string; about: string; default: string | null }[];
		readonly example: { readonly line: string; readonly input: object };
	};
}

interface Listed {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: { properties: Record<string, { description: string }> };
}

/** The tools as the browser gives them to an agent. */
const listed = (page: Page): Promise<Listed[]> =>
	page.evaluate(async () =>
		(await document.modelContext.getTools()).map((tool) => {
			const { name, description, inputSchema } = tool as unknown as Listed & { inputSchema: unknown };
			const schema: unknown = typeof inputSchema === "string" ? JSON.parse(inputSchema) : inputSchema;
			return { name, description, inputSchema: schema as Listed["inputSchema"] };
		}),
	);

test("help lists and explains the verbs, and lab_help and the tools themselves say the same to an agent", async ({
	page,
}) => {
	await openLab(page);
	const all = await helped(page, "help");
	expect(all.rows.map(([verb]) => verb)).toEqual(
		"spawn rm ls exec write sh link plug unplug mkswitch rmswitch cable uncable vlan trunk stp priority cost topology macs capture focus boot reboot poweroff checkpoint restore forget help".split(
			" ",
		),
	);
	expect(all.header).toBe("29 verbs");
	expect(await call(page, "lab_help", {})).toMatchObject({
		result: "29 verbs",
		data: all.rows.map(([verb, about]) => ({ verb, about })),
	});

	const spawn = await helped(page, "help spawn");
	expect(spawn.rows.map(([term]) => term)).toEqual(
		expect.arrayContaining([
			"[--extra-disk GiB,...]",
			"[--name name]",
			"[--nics NICs]",
			"[--net network,... | --no-net]",
			"[--addr address,...]",
			"[--no-gateway]",
		]),
	);
	await page.keyboard.press("ArrowUp");
	await expect(page.getByRole("combobox", { name: "Command" })).toHaveValue("help spawn");

	const tools = await listed(page);
	for (const [verb] of all.rows) {
		const { header, rows } = await helped(page, `help ${verb}`);
		const { result, data } = (await call(page, "lab_help", { verb })) as Told;
		expect(result).toBe(header);
		expect(rows).toEqual([
			["does", data.description],
			...data.arguments.map((a) => [a.written, a.default === null ? a.about : `${a.about} Left out, ${a.default}.`]),
			["example", data.example.line],
			...(data.tool === null ? [] : [["agent tool", data.tool]]),
		]);
		if (data.tool === null) continue;
		const tool = tools.find(({ name }) => name === data.tool);
		expect(tool?.description).toBe(data.description);
		expect(
			Object.entries(tool?.inputSchema.properties ?? {}).map(([field, { description }]) => [field, description]),
		).toEqual(data.arguments.map(({ field, about }) => [field, about]));
		expect(await call(page, "lab_help", { verb: data.tool })).toEqual({ result, data });
	}
});

test("an example from help runs as it stands, typed or called", async ({ page }) => {
	await openLab(page);
	const { data } = (await call(page, "lab_help", { verb: "spawn" })) as Told;
	await typed(page, data.example.line);
	await expect(page.getByText("1 of 1 ready")).toBeVisible({ timeout: 60_000 });
	expect(await call(page, "machines_list", {})).toMatchObject({
		data: [{ name: "router", state: "ready", nics: [{ address: "10.1.0.1" }, { address: "10.2.0.1" }] }],
	});
	expect(await call(page, "machines_spawn", data.example.input)).toEqual({
		error: "A machine is already called router, so give another name with --name. Nothing was changed.",
	});
});

test("a command for a session that runs a program says so, in the bar and to an agent", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine");
	await expect(page.getByText("1 of 1 ready")).toBeVisible({ timeout: 60_000 });
	await start(page, "sleep", "shell_exec", { targets: "node1", command: "sleep 8" });
	const called = async () =>
		((await call(page, "shell_exec", { targets: "node1", command: "true" })) as { readonly error?: string }).error;
	await expect.poll(called).toContain("node1:console is running a program");
	const error = await called();
	expect(await refused(page, "exec node1 -- true")).toContain(error);
	expect(await finish(page, "sleep")).toMatchObject({ data: { ran: [{ exitCode: 0 }] } });
	expect(await called()).toBeUndefined();
});

/** What the bar says of a line that cannot run. */
async function refused(page: Page, line: string): Promise<string> {
	await closeBar(page);
	await typed(page, line);
	const error = bar(page).getByRole("alert");
	await expect(error).toBeVisible();
	return (await error.locator("p").allTextContents()).join(" ");
}

test("what cannot run is refused in one sentence, the same in the bar and through WebMCP", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 2 alpine --no-gateway");
	await expect(page.getByText("2 of 2 ready")).toBeVisible({ timeout: 60_000 });
	expect(await call(page, "machines_poweroff", { names: "node2" })).toMatchObject({ data: [{ state: "off" }] });

	const rows: readonly (readonly [line: string, tool: string, input: object, sentence: string])[] = [
		[
			"spawn 1 arch",
			"machines_spawn",
			{ count: 1, image: "arch" },
			"No image is called arch, so use alpine, debian or lab.",
		],
		[
			"spawn 15 alpine --no-net",
			"machines_spawn",
			{ count: 15, image: "alpine", net: "none" },
			"The lab holds 16 machines and has room for 14 more, not 15.",
		],
		[
			"spawn 1 alpine --mem 9999",
			"machines_spawn",
			{ count: 1, image: "alpine", mem: 9999 },
			"--mem wants at most 4096 MiB of memory, not 9999.",
		],
		[
			"spawn 2 alpine --nics 4",
			"machines_spawn",
			{ count: 2, image: "alpine", nics: 4 },
			"switch0 has 6 free ports and this takes 8, so add --no-net to boot unplugged, or leave some NICs out with --net switch0,none.",
		],
		[
			"spawn 1 alpine --addr 10.1.0.0/24",
			"machines_spawn",
			{ count: 1, image: "alpine", addr: "10.1.0.0/24" },
			"--addr 10.1.0.0/24 names its whole subnet, so use one from 10.1.0.1 to 10.1.0.254.",
		],
		[
			"spawn 1 alpine --extra-disk 65",
			"machines_spawn",
			{ count: 1, image: "alpine", extraDisk: "65" },
			"--extra-disk wants whole GiB from 1 to 64, such as 1,4, not 65.",
		],
		[
			"spawn 1 alpine --net lan",
			"machines_spawn",
			{ count: 1, image: "alpine", net: "lan" },
			"spawn wants switch0 or none after --net, not lan.",
		],
		["plug node1 lan:3", "cable_plug", { nic: "node1", to: "lan:3" }, "No switch is called lan, so use switch0."],
		["unplug node1:eth1", "cable_unplug", { nic: "node1:eth1" }, "node1 has no NIC called eth1, so use eth0."],
		["mkswitch Lan", "switch_add", { name: "Lan" }, "mkswitch wants lowercase letters, so use lan."],
		[
			"rmswitch switch0",
			"switch_remove",
			{ switch: "switch0" },
			"switch0 cannot be removed, and the lab has no other switch.",
		],
		["rm nodx", "machines_remove", { names: "nodx" }, "No machine is called nodx, so use node1 or node2."],
		[
			"exec node2 -- ls",
			"shell_exec",
			{ targets: "node2", command: "ls" },
			"exec wants a ready machine here, and node2 is off.",
		],
		[
			"write node2 /a -- t",
			"file_write",
			{ machine: "node2", path: "/a", text: "t" },
			"write wants a ready machine here, and node2 is off.",
		],
		["reboot db*", "machines_reboot", { names: "db*" }, "No machine matches db*, so use node1 or node2."],
		[
			"link up node1:eth1",
			"link_set",
			{ link: "up", machines: "node1:eth1" },
			"node1 has no NIC called eth1, so use eth0.",
		],
		[
			"boot node1",
			"machines_boot",
			{ names: "node1" },
			"boot wants an off or failed machine here, and node1 is ready.",
		],
		[
			"restore node1 before",
			"checkpoint_restore",
			{ machine: "node1", checkpoint: "before" },
			"node1 has no checkpoint called before, or any other, so save one first with checkpoint.",
		],
		[
			"help spwan",
			"lab_help",
			{ verb: "spwan" },
			"No verb is called spwan, so use spawn, rm, ls, exec, write, sh, link, plug, unplug, mkswitch, rmswitch, cable, uncable, vlan, trunk, stp, priority, cost, topology, macs, capture, focus, boot, reboot, poweroff, checkpoint, restore, forget or help.",
		],
	];
	for (const [line, tool, input, sentence] of rows) {
		const said = { error: `${sentence} Nothing was changed.` };
		expect(await call(page, tool, input), line).toEqual(said);
		expect(await refused(page, line), line).toBe(said.error);
	}
	expect(await call(page, "shell_read", { machine: "nodx" })).toEqual({
		error: "No machine is called nodx, so use node1 or node2.",
	});
});

test("the bar completes and previews each verb and option as it does spawn", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 alpine --nics 2 --no-gateway");
	await expect(page.getByText("1 of 1 ready")).toBeVisible({ timeout: 60_000 });
	await typed(page, "mkswitch lan");
	await typed(page, "spawn 1 alpine --name web --no-gateway");
	await expect(page.getByText("2 of 2 ready")).toBeVisible({ timeout: 60_000 });
	expect(await call(page, "checkpoint_save", { machine: "node1", checkpoint: "before" })).not.toHaveProperty("error");
	expect(await call(page, "machines_poweroff", { names: "web" })).toMatchObject({ data: [{ state: "off" }] });

	const options = bar(page).getByRole("option");
	const will = bar(page).locator(".will");
	const assumed = "· alpine 3.24 · 256 MiB · ";
	const rows: readonly (readonly [line: string, offered: string | null, will?: string])[] = [
		...[
			"boot",
			"reboot",
			"poweroff",
			"checkpoint",
			"restore",
			"forget",
			"write",
			"help",
			"plug",
			"unplug",
			"mkswitch",
			"rmswitch",
			"cable",
			"uncable",
			"vlan",
			"trunk",
			"stp",
			"topology",
		].map((verb) => [verb.slice(0, -1), verb] as const),
		["spawn 1 la", "lab"],
		["spawn 1 lab", null, "boot node3 · lab"],
		["spawn 1 alpine --ex", "--extra-disk GiB,..."],
		["spawn 1 alpine --extra-disk ", "4 GiB"],
		["spawn 1 alpine --extra-disk 1,", "4 GiB"],
		["spawn 1 alpine --extra-disk 1,4", null, "extra disks of 1 and 4 GiB"],
		["spawn 1 alpine --na", "--name name"],
		["spawn 1 alpine --name db", null, `boot db ${assumed}`],
		["spawn 1 alpine --ni", "--nics NICs"],
		["spawn 1 alpine --nics ", "4"],
		["spawn 1 alpine --nics 2", null, "2 NICs · plugged into switch0 on ports"],
		["spawn 1 alpine --net ", "lan"],
		["spawn 1 alpine --nics 2 --net switch0,lan", null, "plugged into switch0 on port 4 and lan on port 1"],
		["mkswitch", null, "add switch1"],
		["mkswitch wan", null, "add wan"],
		["rmswitch ", "lan", "remove lan"],
		["plug ", "node1:eth1"],
		["plug node1:eth1 ", "lan"],
		["plug node1:eth1 lan:", "lan:8"],
		["plug node1:eth1 lan:8", null, "move node1:eth1 from switch0 port 2 to lan port 8"],
		["unplug ", "web"],
		["unplug web", null, "unplug web from switch0 port 3 · web is off"],
		["cable ", "lan"],
		["cable lan:", "lan:8"],
		["cable lan switch0", null, "cable lan port 1 to switch0 port 4"],
		["cable lan lan", null, "cable lan port 1 to lan port 2 · closes a loop"],
		["topology", null, "list 2 switches"],
		["spawn 1 alpine --nics 2 --net switch0,", "none"],
		["spawn 1 alpine --nics 2 --net switch0,none", null, "eth1 unplugged"],
		["spawn 1 alpine --ad", "--addr address,..."],
		["spawn 1 alpine --addr ", "none"],
		["spawn 1 alpine --addr 10.1.0.1/24", null, "10.1.0.1/24"],
		["spawn 1 alpine --no-g", "--no-gateway"],
		["spawn 1 alpine --no-gateway", null, "no package gateway"],
		["boot ", "web", "boot web"],
		["reboot ", "node1", "reboot node1"],
		["poweroff ", "node1", "power off node1"],
		["link down node1:", "node1:eth1", "cut the cable to node1:eth0"],
		["link down node1:eth1", null, "cut the cable to node1:eth1"],
		["capture node1:eth1", null, "show captured frames matching node1:eth1"],
		["capture arp or la", "lan"],
		["capture lan:", "lan:8"],
		["capture lan:8 icmp", null, "show captured frames matching lan:8 icmp"],
		["checkpoint ", "web"],
		["checkpoint web now", null, "save web's disk as checkpoint now"],
		["restore node1 ", "before", "put node1's disk back to checkpoint before and boot it"],
		["forget node1 ", "before", "delete checkpoint before of node1"],
		["write ", "node1"],
		["write node1 /etc/motd --o", "--owner user[:group]"],
		["write node1 /etc/motd --owner ", "root"],
		["write node1 /etc/motd --mode ", "600"],
		["write node1 /etc/motd --mode 600 -- hello", null, "write /etc/motd on node1 · 1 line, 5 bytes · mode 600"],
		["help ", "checkpoint", "list every verb"],
		["help che", "checkpoint", "explain checkpoint"],
	];
	await page.keyboard.press("Control+/");
	const command = page.getByRole("combobox", { name: "Command" });
	for (const [line, offered, effect] of rows) {
		await command.fill(line);
		if (offered !== null) await expect(options.filter({ hasText: offered }).first(), line).toBeVisible();
		if (effect !== undefined) await expect(will, line).toContainText(effect);
	}
});
