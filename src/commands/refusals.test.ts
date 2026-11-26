import { describe, expect, it } from "vitest";
import { startAgent, type WebMcpTool } from "../agent/index.ts";
import {
	type CheckpointName,
	isNameFault,
	type LabState,
	type MachineName,
	type Phase,
	parseSwitchName,
} from "../model/index.ts";
import { createRegistry, isLineError, parseLine, VERBS } from "./index.ts";
import { fakeDeps, IMAGES, labWith, type MachineFixture } from "./testing/lab.ts";

const registry = createRegistry(fakeDeps(labWith([])).deps, VERBS);
const NOTHING = " Nothing was changed.";

/** What the bar answers to a line that cannot run, or null when it can. */
function bar(line: string, lab: LabState): string | null {
	const parsed = parseLine(registry, line, lab);
	return isLineError(parsed) ? parsed.message : (parsed.validate(lab)?.message ?? null);
}

/** What the tool that is registered answers to a call that cannot run, or null for one that waits for a person. */
async function agent(name: string, input: unknown, lab: LabState): Promise<string | null> {
	const tools = new Map<string, WebMcpTool>();
	const policies = Object.fromEntries(Object.keys(lab.agent.policies).map((tool) => [tool, "ask"]));
	const state = { ...lab, agent: { ...lab.agent, policies: policies as LabState["agent"]["policies"] } };
	let waits = false;
	startAgent({
		store: {
			state,
			subscribe: () => () => {},
			dispatchAgent(event) {
				if (event.type === "agent/call") waits = event.call.status === "waiting";
			},
		},
		registry,
		screens: { get: () => undefined },
		capture: { frames: () => [] },
		modelContext: { registerTool: (tool) => tools.set(tool.name, tool) },
	});
	const tool = tools.get(name);
	if (!tool) throw new Error(`no tool called ${name}`);
	const reply = tool.execute(input, {});
	if (waits) return null;
	const answer = await reply;
	if (typeof answer !== "object" || answer === null || !("error" in answer)) throw new Error(`${name} ran`);
	return String(answer.error);
}

function withCheckpoint(lab: LabState, name: MachineName): LabState {
	const machine = lab.machines[name];
	if (!machine) throw new Error(`no ${name}`);
	const checkpoints = [{ name: "before" as CheckpointName, set: 1, bytes: 5 }];
	const sets = { ...machine.sets, next: 2, checkpoints };
	return { ...lab, machines: { ...lab.machines, [name]: { ...machine, sets } } };
}

function withSwitch(lab: LabState, text: string): LabState {
	const name = parseSwitchName(text);
	if (isNameFault(name)) throw new Error(`${text}: ${name.kind}`);
	return { ...lab, switches: ["switch0", name] };
}

const images = [...IMAGES, { name: "lab", label: "lab" }];
const fixtures: readonly MachineFixture[] = [
	{ n: 1 },
	{ n: 2 },
	{ n: 3, phase: "off" },
	{ n: 4, name: "web" as MachineName },
	{ n: 5, phase: "booting" },
];
const plain = labWith(fixtures, images);
const lab = withCheckpoint(plain, "node2");

const switched = withSwitch(plain, "lan");

const wan = withSwitch(plain, "wan").switches[1];
const two: LabState = { ...switched, switches: [...switched.switches, wan] };
const cabled: LabState = {
	...two,
	switchCables: [
		{
			ends: [
				{ switch: switched.switches[1], port: 3 },
				{ switch: wan, port: 8 },
			],
			link: "up",
		},
	],
};

const LABS: Readonly<Record<string, LabState>> = {
	checkpoint: plain,
	boot: labWith([{ n: 1 }, { n: 2, phase: "off" }], images),
	rmswitch: switched,
	plug: switched,
	cable: two,
	uncable: cabled,
	trunk: cabled,
};

/** The labs that the examples make sense in: `boot` wants node2 off, and `checkpoint` a name that is free. */
const labFor = (verb: string): LabState => LABS[verb] ?? lab;

/** One sentence: it ends once, in a full stop. */
function expectSentence(message: string | null): string {
	expect(message).toMatch(/^[^\s].*[^.!?]\.$/);
	expect(message).not.toMatch(/[.!?]\s/);
	return String(message);
}

/** As the bar and the verb's tool say it, one sentence and then that nothing was changed. */
function sentenceOf(message: string | null): string {
	expect(message?.endsWith(NOTHING), String(message)).toBe(true);
	return expectSentence(String(message).slice(0, -NOTHING.length));
}

describe("every verb", () => {
	const all = registry.commands.map(({ manual }) => manual);
	const tail = (line: string) => line.indexOf(" -- ");
	/** The line with words put after its last plain argument. */
	const insert = (line: string, words: string) =>
		tail(line) < 0 ? `${line} ${words}` : `${line.slice(0, tail(line))} ${words}${line.slice(tail(line))}`;

	it.each(all)("$verb runs its own example, as a line and as its tool's input", async ({ verb, tool, example }) => {
		expect(bar(example.line, labFor(verb))).toBeNull();
		if (tool !== null) expect(await agent(tool, example.input, labFor(verb))).toBeNull();
	});

	it.each(all)("$verb names an option that it does not have, and those that it has", ({ verb, arguments: args }) => {
		const flags = args.flatMap(({ written }) => written.match(/--[a-z-]+/g) ?? []);
		const said = sentenceOf(bar(`${verb} --bogus`, lab));
		expect(said).toMatch(new RegExp(`^${verb} has no option --bogus, so `));
		for (const flag of flags) expect(said).toContain(flag);
	});

	it.each(all)(
		"$verb names each argument that is missing, and one that would do",
		async ({ verb, arguments: args, tool, example }) => {
			const head = example.line.split(" -- ")[0].split(" --")[0].split(" ");
			const needed = args.filter(({ required }) => required);
			for (const [i, { field, written }] of needed.entries()) {
				const said = sentenceOf(bar([...head.slice(0, i + 1)].join(" "), labFor(verb)));
				expect(said).toMatch(
					new RegExp(written.startsWith("--") ? `^${verb} wants a .* after --\\.$` : `^${verb} needs `),
				);
				if (tool === null) continue;
				const { [field]: value, ...rest } = example.input;
				expect(sentenceOf(await agent(tool, rest, labFor(verb)))).toBe(
					`${verb} needs the ${field} field, such as ${JSON.stringify(value)}.`,
				);
			}
		},
	);

	it.each(all.filter(({ verb }) => verb !== "capture"))(
		"$verb names an argument that is one too many",
		({ verb, example }) => {
			const said = sentenceOf(bar(insert(example.line, "extra"), labFor(verb)));
			expect(said).toMatch(new RegExp(`^${verb} takes .*, so leave out extra\\.$`));
		},
	);

	it.each(all.filter(({ example }) => tail(example.line) < 0))("$verb takes nothing after --", ({ verb, example }) => {
		expect(sentenceOf(bar(`${example.line} -- more`, labFor(verb)))).toBe(
			`${verb} takes nothing after --, so leave it out.`,
		);
	});

	it.each(all.filter(({ tool }) => tool !== null))(
		"$tool names a field that it does not have, and those that it has",
		async ({ verb, tool, arguments: args, example }) => {
			const said = sentenceOf(await agent(String(tool), { ...example.input, bogus: 1 }, labFor(verb)));
			expect(said).toMatch(new RegExp(`^${verb} has no field called bogus, so `));
			for (const { field } of args) expect(said).toContain(field);
			expect(sentenceOf(await agent(String(tool), [], lab))).toBe(
				`${verb} wants its input as an object of fields, such as ${JSON.stringify(example.input)}.`,
			);
		},
	);

	it("names what is no verb, and the verbs there are", async () => {
		const verbs = all.map(({ verb }) => verb);
		const use = `so use ${verbs.slice(0, -1).join(", ")} or help.`;
		expect(sentenceOf(bar("spwan 1 alpine", lab))).toBe(`No verb is called spwan, ${use}`);
		expect(sentenceOf(bar("help spwan", lab))).toBe(`No verb is called spwan, ${use}`);
		expect(sentenceOf(await agent("lab_help", { verb: "spwan" }, lab))).toBe(`No verb is called spwan, ${use}`);
		expect(sentenceOf(bar("", lab))).toBe(`Type a verb first: ${verbs.join(", ")}.`);
	});
});

const MACHINES = "so use node1, node2, node3, web or node5.";
const NAME_SHAPE =
	"wants lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as web-1, not my_web.";
const long = "w".repeat(64);
const path = `/${"a".repeat(4095)}`;

type Row = readonly [line: string, sentence: string, tool?: readonly [string, object], on?: LabState];

const spawnOption = (flag: string, field: string, value: string, sentence: string): Row => [
	`spawn 1 alpine ${flag} ${value}`,
	sentence,
	["machines_spawn", { count: 1, image: "alpine", [field]: value }],
];
const write = (options: string, input: object, sentence: string): Row => [
	`write ${options} -- t`,
	sentence,
	["file_write", { machine: "node1", path: "/a", text: "t", ...input }],
];
const names = (verb: string, tool: string | null, value: string, sentence: string): Row =>
	tool === null ? [`${verb} ${value}`, sentence] : [`${verb} ${value}`, sentence, [tool, { names: value }]];
const exec = (targets: string, sentence: string, command = "ls"): Row => [
	`exec ${targets} -- ${command}`,
	sentence,
	["shell_exec", { targets, command }],
];
const link = (machines: string, sentence: string, dir = "up"): Row => [
	`link ${dir} ${machines}`,
	sentence,
	["link_set", { link: dir, machines }],
];
const conditions = (options: string, input: object, sentence: string): Row => [
	`link up node1 ${options}`,
	sentence,
	["link_set", { link: "up", machines: "node1", ...input }],
];
const plugIn = (nic: string, to: string, sentence: string, on?: LabState): Row => [
	`plug ${nic} ${to}`,
	sentence,
	["cable_plug", { nic, to }],
	on,
];
const saved = (verb: string, tool: string, machine: string, checkpoint: string, sentence: string): Row => [
	`${verb} ${machine} ${checkpoint}`,
	sentence,
	[tool, { machine, checkpoint }],
];

const ROWS: readonly Row[] = [
	[
		"spawn lots alpine",
		"spawn wants a count such as 2 here, not lots.",
		["machines_spawn", { count: "lots", image: "alpine" }],
	],
	["spawn 0 alpine", "spawn wants a count such as 2 here, not 0.", ["machines_spawn", { count: 0, image: "alpine" }]],
	[
		"spawn 12 alpine --no-net",
		"The lab holds 16 machines and has room for 11 more, not 12.",
		["machines_spawn", { count: 12, image: "alpine", net: "none" }],
	],
	[
		"spawn 1 arch",
		"No image is called arch, so use alpine, debian or lab.",
		["machines_spawn", { count: 1, image: "arch" }],
	],
	["spawn 1 alpine --mem", "spawn wants a size in MiB such as 512 after --mem."],
	["spawn 1 alpine --mem 1 --mem 2", "spawn takes --mem once."],
	["spawn 1 alpine --net none --no-net", "spawn takes --net or --no-net, not both."],
	spawnOption("--mem", "mem", "lots", "spawn wants a size in MiB such as 512 after --mem, not lots."),
	spawnOption("--mem", "mem", "4097", "--mem wants at most 4096 MiB of memory, not 4097."),
	spawnOption("--cpus", "cpus", "none", "spawn wants a number of CPUs such as 2 after --cpus, not none."),
	spawnOption("--cpus", "cpus", "17", "--cpus wants 1 to 16 CPUs, not 17."),
	spawnOption("--disk", "disk", "5", "spawn wants 4, 8, 16, 32 or 64 after --disk, not 5."),
	spawnOption("--extra-disk", "extraDisk", "0", "--extra-disk wants whole GiB from 1 to 64, such as 1,4, not 0."),
	spawnOption("--extra-disk", "extraDisk", "1,65", "--extra-disk wants whole GiB from 1 to 64, such as 1,4, not 65."),
	spawnOption(
		"--extra-disk",
		"extraDisk",
		"1,",
		"--extra-disk wants whole GiB from 1 to 64, such as 1,4, not nothing.",
	),
	spawnOption("--extra-disk", "extraDisk", "1,1,1,1,1", "A machine has up to 4 extra disks, and --extra-disk names 5."),
	spawnOption("--name", "name", "Web", "--name wants lowercase letters, so use web."),
	spawnOption("--name", "name", "my_web", `--name ${NAME_SHAPE}`),
	spawnOption("--name", "name", long, "--name wants at most 63 characters, and that is 64."),
	spawnOption("--name", "name", "all", "all already means something in the lab, so use another name, such as all-1."),
	spawnOption("--name", "name", "node9", "The lab gives out node9 itself, so use another name, such as web-1."),
	spawnOption("--name", "name", "web", "A machine is already called web, so give another name with --name."),
	[
		"spawn 2 alpine --name db",
		"--name names one machine, so spawn 1 at a time with it.",
		["machines_spawn", { count: 2, image: "alpine", name: "db" }],
	],
	spawnOption("--nics", "nics", "two", "spawn wants a number of NICs such as 2 after --nics, not two."),
	spawnOption("--nics", "nics", "5", "--nics wants 1 to 4 NICs, not 5."),
	spawnOption("--net", "net", "lan", "spawn wants switch0 or none after --net, not lan."),
	[
		"mkswitch my_lan",
		`mkswitch ${NAME_SHAPE.replace("web-1", "lan").replace("my_web", "my_lan")}`,
		["switch_add", { name: "my_lan" }],
	],
	["mkswitch web", "A machine is already called web, so give another name.", ["switch_add", { name: "web" }]],
	[
		"mkswitch none",
		"none already means something in the lab, so use another name, such as none-1.",
		["switch_add", { name: "none" }],
	],
	[
		"mkswitch node9",
		"The lab gives out node9 itself, so use another name, such as lan.",
		["switch_add", { name: "node9" }],
	],
	[
		"rmswitch switch0",
		"switch0 cannot be removed, and the lab has no other switch.",
		["switch_remove", { switch: "switch0" }],
	],
	[
		"rmswitch lan",
		"No switch is called lan, and switch0, the only one, cannot be removed.",
		["switch_remove", { switch: "lan" }],
	],
	spawnOption("--net", "net", "switch0,wan", "spawn wants switch0 or none after --net, not wan."),
	spawnOption("--net", "net", "switch0,", "spawn wants switch0 or none after --net, not nothing."),
	spawnOption("--net", "net", "none,none", "--net names 2 NICs, so add --nics 2."),
	spawnOption(
		"--addr",
		"addr",
		"here",
		"--addr wants an address with its prefix, such as 10.1.0.1/24, or none, not here.",
	),
	spawnOption("--addr", "addr", "10.1.0.1", "--addr 10.1.0.1 needs a prefix from 1 to 32, as in 10.1.0.1/24."),
	spawnOption(
		"--addr",
		"addr",
		"10.1.0.0/24",
		"--addr 10.1.0.0/24 names its whole subnet, so use one from 10.1.0.1 to 10.1.0.254.",
	),
	spawnOption(
		"--addr",
		"addr",
		"10.1.0.255/24",
		"--addr 10.1.0.255/24 is its subnet's broadcast address, so use one from 10.1.0.1 to 10.1.0.254.",
	),
	spawnOption(
		"--addr",
		"addr",
		"127.0.0.1/8",
		"--addr 127.0.0.1/8 is not an address a NIC can have, so use one such as 10.1.0.1/24.",
	),
	spawnOption("--addr", "addr", "10.1.0.1/24,none", "--addr names 2 NICs, so add --nics 2."),
	spawnOption("--addr", "addr", "10.88.0.11/24", "10.88.0.11 is already node1's, so give another address with --addr."),
	spawnOption(
		"--addr",
		"addr",
		"10.0.2.5/24",
		"--addr 10.0.2.5/24 overlaps 10.0.2.0/24, which the package gateway uses, so choose another subnet or add --no-gateway.",
	),
	[
		"spawn 2 alpine --addr 10.1.0.1/24",
		"--addr gives one machine its addresses, so spawn 1 at a time with it.",
		["machines_spawn", { count: 2, image: "alpine", addr: "10.1.0.1/24" }],
	],
	[
		"spawn 1 alpine --nics 2 --addr 10.1.0.1/24",
		"--addr names 1 NIC of 2, so end it with none for each of the others.",
		["machines_spawn", { count: 1, image: "alpine", nics: 2, addr: "10.1.0.1/24" }],
	],
	[
		"spawn 1 alpine --nics 2 --addr 10.1.0.1/24,10.1.0.2/24",
		"--addr puts eth0 and eth1 in overlapping subnets, so give each its own, as in 10.1.0.1/24,10.2.0.1/24.",
		["machines_spawn", { count: 1, image: "alpine", nics: 2, addr: "10.1.0.1/24,10.1.0.2/24" }],
	],
	[
		"spawn 2 alpine --nics 4",
		"switch0 has 3 free ports and this takes 8, so add --no-net to boot unplugged, or leave some NICs out with --net switch0,none.",
		["machines_spawn", { count: 2, image: "alpine", nics: 4 }],
	],
	names("rm", "machines_remove", "nodx", `No machine is called nodx, ${MACHINES}`),
	names("rm", "machines_remove", "db*", `No machine matches db*, ${MACHINES}`),
	names("rm", "machines_remove", "node1,", "rm wants machines such as node1,node3 or all here, not node1,."),
	...["boot", "reboot", "poweroff"].map((verb) =>
		names(verb, `machines_${verb}`, "nodx", `No machine is called nodx, ${MACHINES}`),
	),
	exec("nodx", `No machine is called nodx, ${MACHINES}`),
	exec("db*", `No machine matches db*, ${MACHINES}`),
	exec("node1,,web", "exec wants machines or sessions such as node1,node2:sh1 or all here, not node1,,web."),
	exec("node1:sh4", "node1 has no session called sh4, so use console."),
	exec("node1", "exec wants a command of printable characters after --.", "a\u0007b"),
	write("nodx /a", { machine: "nodx" }, `No machine is called nodx, ${MACHINES}`),
	write("node1 a", { path: "a" }, "write wants a path that starts with /, such as /etc/motd, not a."),
	write("node1 /a/", { path: "/a/" }, "/a/ names a directory, so give the path of a file in it, such as /a/motd."),
	write("node1 /a/../b", { path: "/a/../b" }, "/a/../b has a part that is only dots, so give the path without it."),
	write(`node1 ${path}`, { path }, "A path has at most 4095 bytes, and that is 4096."),
	write(
		"node1 /a --owner a:b:c",
		{ owner: "a:b:c" },
		"--owner wants a user or user:group, such as root or www-data:adm, not a:b:c.",
	),
	write("node1 /a --mode 9", { mode: "9" }, "--mode wants three or four octal digits, such as 644, not 9."),
	[
		"write node1 /a -- x\ud800",
		"text has half of a surrogate pair in it, which is no character, so leave it out.",
		["file_write", { machine: "node1", path: "/a", text: "x\ud800" }],
	],
	names("sh", null, "nodx", `No machine is called nodx, ${MACHINES}`),
	link("node1", "link wants up or down here, not over.", "over"),
	link("nodx", `No machine is called nodx, ${MACHINES}`),
	link("node1:eth1", "node1 has no NIC called eth1, so use eth0."),
	link("all:wlan0", "No NIC is called wlan0, so use eth0, eth1, eth2 or eth3."),
	link("node1,", "link wants machines such as node1,node3:eth1 or all here, not node1,."),
	link(
		"node*:eth3",
		"link wants a ready or off machine here, and node1 has no eth3, node2 has no eth3, node3 has no eth3 and node5 is still booting.",
	),
	conditions(
		"--delay fast",
		{ delay: "fast" },
		"fast is no delay, so use one from 1ms to 10s in whole milliseconds, such as 100ms, or 0 for none.",
	),
	conditions("--loss 120%", { loss: "120%" }, "120% is no share of frames, so use one from 0 to 100%, such as 20%."),
	conditions(
		"--rate 10",
		{ rate: 10 },
		"10 is no rate, so use one from 1kbit to 10gbit, such as 1mbit, or 0 for none.",
	),
	conditions("--mtu 9000", { mtu: 9000 }, "9000 is no MTU, so use one from 68 to 1500 bytes, such as 1400."),
	conditions(
		"--reorder 25%",
		{ reorder: "25%" },
		"Reordering lets frames skip a cable's delay, and node1 has none, so give --delay too, such as --delay 20ms.",
	),
	[
		"link up node1 --speed 1mbit",
		"link has no option --speed, so use --delay, --loss, --reorder, --rate, --mtu or --clear.",
	],
	plugIn("nodx", "switch0", `No machine is called nodx, ${MACHINES}`),
	plugIn("node1:eth1", "switch0", "node1 has no NIC called eth1, so use eth0."),
	plugIn("node1:", "switch0", "node1: names no NIC, so use eth0."),
	plugIn("all", "switch0", "plug takes one NIC at a time, such as node2 or node2:eth1, not all."),
	plugIn("node1,web", "switch0", "plug takes one NIC at a time, such as node2 or node2:eth1, not node1,web."),
	plugIn("node1", "lan", "No switch is called lan, so use switch0."),
	plugIn("node1", "wan:3", "No switch is called wan, so use switch0 or lan.", switched),
	plugIn("node1", "node2", "No switch is called node2, so use switch0 or lan.", switched),
	plugIn("node1", ":3", ":3 names no switch, so use switch0 or lan.", switched),
	plugIn("node1", "none", "none is no switch, so use unplug to take the cable out."),
	...["lan:9", "lan:0", "lan:03", "lan:", "lan:3:3", "lan:eth0"].map((to) =>
		plugIn("node1", to, `${to} is no port, so use one from lan:1 to lan:8.`, switched),
	),
	plugIn("node1", "switch0:2", "switch0:2 is taken by node2, so use switch0:6.", switched),
	["unplug nodx", `No machine is called nodx, ${MACHINES}`, ["cable_unplug", { nic: "nodx" }]],
	["unplug node1:eth1", "node1 has no NIC called eth1, so use eth0.", ["cable_unplug", { nic: "node1:eth1" }]],
	[
		"unplug node*",
		"unplug takes one NIC at a time, such as node2 or node2:eth1, not node*.",
		["cable_unplug", { nic: "node*" }],
	],
	[
		"capture bogus",
		"capture cannot read bogus, so use a protocol, a machine, a NIC (node2:eth1), an address, a MAC, vlan N or port:N.",
	],
	["capture arp or", "capture needs a term on each side of or, such as arp or icmp."],
	names("focus", null, "nodx", `No machine is called nodx, ${MACHINES}`),
	names("focus", null, "node1:sh4", "node1 has no session called sh4, so use console."),
	["focus node1 --main --max", "focus takes --main or --max, not both."],
	...(
		[
			["checkpoint", "checkpoint_save"],
			["restore", "checkpoint_restore"],
			["forget", "checkpoint_remove"],
		] as const
	).flatMap(([verb, tool]): Row[] => [
		saved(verb, tool, "nodx", "before", `No machine is called nodx, ${MACHINES}`),
		saved(verb, tool, "node2", "Before", "A checkpoint's name is in lowercase letters, so use before."),
		saved(verb, tool, "node2", long, "A checkpoint's name has at most 63 characters, and that is 64."),
		saved(
			verb,
			tool,
			"node2",
			"a_b",
			`${verb} wants a name of lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as before-upgrade, not a_b.`,
		),
	]),
	saved(
		"checkpoint",
		"checkpoint_save",
		"node2",
		"before",
		"node2 already has a checkpoint called before, so choose another name, or delete it with forget.",
	),
	...(
		[
			["restore", "checkpoint_restore"],
			["forget", "checkpoint_remove"],
		] as const
	).flatMap(([verb, tool]): Row[] => [
		saved(verb, tool, "node2", "after", "node2 has no checkpoint called after, so use before."),
		saved(
			verb,
			tool,
			"web",
			"before",
			"web has no checkpoint called before, or any other, so save one first with checkpoint.",
		),
	]),
];

describe("a line that cannot run", () => {
	it.each(ROWS.map(([line, sentence, tool, on = lab]) => ({ line, sentence, tool, on })))(
		"$line",
		async ({ line, sentence, tool, on }) => {
			expect(sentenceOf(bar(line, on))).toBe(sentence);
			if (tool) expect(await agent(tool[0], tool[1], on)).toBe(bar(line, on));
		},
	);

	it("says what to do first in a lab with no machines", () => {
		const empty = labWith([]);
		expect(sentenceOf(bar("rm node1", empty))).toBe(
			"No machine is called node1, and the lab has none yet, so spawn one first.",
		);
		expect(sentenceOf(bar("exec all -- ls", empty))).toBe("The lab has no machine for exec yet, so spawn one first.");
	});

	it("names the limit that a lab with eight switches is at", async () => {
		const [first] = lab.switches;
		const names = ["a", "b", "c", "d", "e", "f", "g"].map((text) => withSwitch(lab, text).switches[1] ?? first);
		const full: LabState = { ...lab, switches: [first, ...names] };
		const limit = "The lab has all 8 switches that it can, so remove one with rmswitch first.";
		expect(sentenceOf(bar("mkswitch", full))).toBe(limit);
		expect(sentenceOf(await agent("switch_add", { name: "lan" }, full))).toBe(limit);
	});

	it("names the limit that a lab with sixteen machines is at, and the ports that a full switch has none of", async () => {
		const sixteen = Array.from({ length: 16 }, (_, i): MachineFixture => ({ n: i + 1, link: i < 8 ? "up" : "none" }));
		const full = labWith(sixteen);
		const limit = "The lab has all 16 machines that it can, so remove one with rm first.";
		for (const line of ["spawn 1 alpine", "spawn 1 alpine --no-net"]) expect(sentenceOf(bar(line, full))).toBe(limit);
		expect(sentenceOf(await agent("machines_spawn", { count: 1, image: "alpine" }, full))).toBe(limit);
		const numbered: LabState = { ...labWith([{ n: 1 }]), nextN: 243 };
		expect(sentenceOf(bar("spawn 3 alpine", numbered))).toBe(
			"The lab has room for 2 more machines, not 3, because node244 is the last it can number.",
		);
		expect(sentenceOf(bar("spawn 1 alpine", { ...numbered, nextN: 245 }))).toBe(
			"The lab has numbered its machines up to node244, the last it can, so it can boot no more.",
		);
		const failed = labWith([{ n: 1, phase: "failed" }, ...[2, 3, 4, 5, 6, 7].map((n) => ({ n })), { n: 8 }, { n: 9 }]);
		for (const line of ["boot node1", "restore node1 before"]) {
			expect(sentenceOf(bar(line, withCheckpoint(failed, "node1")))).toBe(
				"switch0 has 0 free ports and this takes 1, so remove a machine with rm to free its ports.",
			);
		}
	});
});

describe("a tool's input that is no line", () => {
	it.each([
		[
			"machines_spawn",
			{ count: true, image: "alpine" },
			"count must be one word that does not start with -, not true.",
		],
		["machines_spawn", { count: 1, image: "alpine", gateway: false }, 'gateway must be "on" or "off", not false.'],
		[
			"machines_spawn",
			{ count: 1, image: "alpine", net: ["none"] },
			'net must be one word that does not start with -, not ["none"].',
		],
		[
			"machines_spawn",
			{ count: 1, image: "alpine", mem: "1 --no-net" },
			'mem must be one word that does not start with -, not "1 --no-net".',
		],
		[
			"shell_exec",
			{ targets: "node1", command: "a\nb" },
			String.raw`command must be a string on one line, not "a\nb".`,
		],
		["shell_exec", { targets: "node1", command: 5 }, "command must be a string on one line, not 5."],
		["file_write", { machine: "node1", path: "/a", text: 5 }, "text must be a string, not 5."],
		[
			"file_write",
			{ machine: "node1", path: 5, text: "" },
			"write wants a path that starts with /, such as /etc/motd, not 5.",
		],
	])("%s %j", async (tool, input, sentence) => {
		expect(sentenceOf(await agent(tool, input, lab))).toBe(sentence);
	});

	it.each([
		["shell_read", "x", 'shell_read wants its input as an object of fields, not "x".'],
		["shell_read", {}, 'shell_read needs the machine field, such as "node2".'],
		["shell_read", { machine: 5 }, 'shell_read needs the machine field, such as "node2".'],
		["shell_read", { machine: "nodx" }, `No machine is called nodx, ${MACHINES}`],
		["shell_read", { machine: "node1:sh4" }, "node1 has no session called sh4, so use console."],
		["shell_read", { machine: "node1", lines: 0 }, "shell_read wants lines as a whole number from 1 to 500, not 0."],
		["shell_read", { machine: "node1", tail: 5 }, "shell_read has no field called tail, so use machine or lines."],
		["capture_read", [], "capture_read wants its input as an object of fields, not []."],
		["capture_read", { filter: 5 }, "capture_read wants filter as a string, not 5."],
		["capture_read", { limit: 1001 }, "capture_read wants limit as a whole number from 1 to 1000, not 1001."],
		["capture_read", { max: 5 }, "capture_read has no field called max, so use filter or limit."],
		[
			"capture_read",
			{ filter: "bogus" },
			"Capture cannot read bogus, so use a protocol, a machine, a NIC (node2:eth1), an address, a MAC, vlan N or port:N.",
		],
		["capture_read", { filter: "or arp" }, "Capture needs a term on each side of or, such as arp or icmp."],
	])("%s %j", async (tool, input, sentence) => {
		expect(expectSentence(await agent(tool, input, lab))).toBe(sentence);
	});
});

const STATE: Readonly<Record<Phase, string>> = {
	booting: "node1 is still booting",
	ready: "node1 is ready",
	stopping: "node1 is stopping",
	off: "node1 is off",
	restoring: "node1 is being restored",
	failed: "node1 has failed",
	removing: "node1 is being removed",
};
const PHASES: readonly Phase[] = ["booting", "ready", "stopping", "off", "restoring", "failed", "removing"];
const READY = ["ready"];
const ANY = PHASES.filter((phase) => phase !== "removing");

describe("a machine that is not in a state for it", () => {
	const takes: readonly (readonly [
		line: string | null,
		phases: readonly string[],
		tool?: readonly [string, object],
	])[] = [
		["exec node1 -- ls", READY, ["shell_exec", { targets: "node1", command: "ls" }]],
		["exec node1:console -- ls", READY, ["shell_exec", { targets: "node1:console", command: "ls" }]],
		["exec all -- ls", READY, ["shell_exec", { targets: "all", command: "ls" }]],
		["write node1 /a -- t", READY, ["file_write", { machine: "node1", path: "/a", text: "t" }]],
		["sh node1", READY],
		["reboot node1", READY, ["machines_reboot", { names: "node1" }]],
		["poweroff node*", READY, ["machines_poweroff", { names: "node*" }]],
		["link down node1", ["ready", "off"], ["link_set", { link: "down", machines: "node1" }]],
		["link up node1:eth0", ["ready", "off"], ["link_set", { link: "up", machines: "node1:eth0" }]],
		["plug node1 switch0:8", ["ready", "off"], ["cable_plug", { nic: "node1", to: "switch0:8" }]],
		["unplug node1:eth0", ["ready", "off"], ["cable_unplug", { nic: "node1:eth0" }]],
		["checkpoint node1 after", ["ready", "off"], ["checkpoint_save", { machine: "node1", checkpoint: "after" }]],
		["boot node1", ["off", "failed"], ["machines_boot", { names: "node1" }]],
		[
			"restore node1 before",
			["ready", "off", "failed"],
			["checkpoint_restore", { machine: "node1", checkpoint: "before" }],
		],
		["forget node1 before", ANY, ["checkpoint_remove", { machine: "node1", checkpoint: "before" }]],
		["rm node1", ANY, ["machines_remove", { names: "node1" }]],
		["focus node1", ANY],
		[null, ANY, ["shell_read", { machine: "node1" }]],
		[null, ANY, ["shell_read", { machine: "node1:console" }]],
		// A filter is about frames, so it takes a machine in any state.
		["capture node1", PHASES],
		[null, PHASES, ["capture_read", { filter: "node1" }]],
	];
	const cases = takes.flatMap(([line, phases, tool]) =>
		PHASES.map((phase) => ({ line, tool, phase, takes: phases.includes(phase), what: line ?? JSON.stringify(tool) })),
	);

	it.each(cases)("$what on one that is $phase", async ({ line, tool, phase, takes }) => {
		const one = withCheckpoint(labWith([{ n: 1, phase }]), "node1");
		// What is being restored keeps the checkpoint that it is restored from.
		const now = phase === "restoring" ? withoutSource(one) : one;
		const said = [
			...(line === null ? [] : [bar(line, now)]),
			...(tool === undefined ? [] : [await agent(tool[0], tool[1], now)]),
		];
		for (const message of said) {
			if (takes) expect(message).toBeNull();
			else {
				const sentence = expectSentence(String(message).replace(NOTHING, ""));
				expect(sentence).toMatch(new RegExp(`^\\w+ wants an? .*machine.* here, and ${STATE[phase]}\\.$`));
			}
		}
		expect(new Set(said).size).toBe(1);
	});
});

function withoutSource(lab: LabState): LabState {
	const machine = lab.machines.node1;
	if (machine?.life.phase !== "restoring") throw new Error("node1 is not restoring");
	const life = { ...machine.life, from: { ...machine.life.from, set: 9 } };
	return { ...lab, machines: { ...lab.machines, node1: { ...machine, life } } };
}
