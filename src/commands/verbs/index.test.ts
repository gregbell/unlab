import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isLineError } from "../index.ts";
import { storeLab } from "../testing/store.ts";

describe("VERBS", () => {
	it("is the verbs group, in the bar's order, each with its signature and what it does", () => {
		const { registry } = storeLab();
		expect(registry.commands.map((c) => [c.name, c.signature.join(" "), c.about])).toEqual([
			[
				"spawn",
				"<count> <image> [--mem MiB] [--cpus CPUs] [--disk 4 | 8 | 16 | 32 | 64] [--extra-disk GiB,...] [--name name] [--nics NICs] [--net network,... | --no-net] [--addr address,...] [--no-gateway]",
				"boot machines",
			],
			["rm", "<machines>", "remove machines and their disks"],
			["ls", "", "list machines, addresses, links and disks"],
			["exec", "<machines> -- <command>", "run a shell command in each console"],
			["write", "<machine> <path> [--owner user[:group]] [--mode mode] -- <text>", "put a text in a file on a machine"],
			["sh", "<machine>", "open another shell on a machine"],
			[
				"link",
				"<up | down> <machines> [--delay time] [--loss percent] [--reorder percent] [--rate rate] [--mtu bytes] [--clear]",
				"plug or cut cables, and set their conditions",
			],
			["plug", "<nic> <switch[:port]>", "plug a NIC into a switch, or move its cable there"],
			["unplug", "<nic>", "unplug a NIC and free its port"],
			["mkswitch", "[name]", "add a switch"],
			["rmswitch", "<switch>", "remove a switch and unplug what is in it"],
			["cable", "<switch[:port]> <switch[:port]>", "cable two switches together"],
			["uncable", "<switch:port>", "remove a cable between switches"],
			["vlan", "<port> <vlan>", "put a switch port in a VLAN"],
			["trunk", "<port> [--allow vlan,...] [--native vlan]", "make a switch port a trunk of several VLANs"],
			["stp", "<on | off> <switches>", "turn spanning tree on or off for switches"],
			["priority", "<switches> <priority>", "set a switch's priority in the spanning tree"],
			["cost", "<port> <cost>", "set what a switch port costs in the spanning tree"],
			["topology", "", "list switches, their ports and what is plugged in"],
			["capture", "<filter>", "filter the packet capture"],
			["focus", "<machine or session> [--main | --max]", "move the keyboard to a console"],
			["boot", "<machines>", "boot machines that are off or failed"],
			["reboot", "<machines>", "shut machines down and boot them again"],
			["poweroff", "<machines>", "shut machines down and keep their disks"],
			["checkpoint", "<machine> <checkpoint>", "save a machine's disks as they are now"],
			["restore", "<machine> <checkpoint>", "go back to a checkpoint and boot"],
			["forget", "<machine> <checkpoint>", "delete a checkpoint"],
			["help", "[verb]", "list the verbs, or explain one"],
		]);
	});

	it("exposes the handoff's tools with their policies and annotations, and nothing else", () => {
		const { registry } = storeLab();
		const tools = registry.commands.flatMap((c) =>
			c.tool ? [[c.name, c.tool.name, c.tool.policy, c.tool.annotations] as const] : [],
		);
		expect(tools).toEqual([
			["spawn", "machines_spawn", "ask", {}],
			["rm", "machines_remove", "ask", { consequentialHint: true }],
			["ls", "machines_list", "run", { readOnlyHint: true }],
			["exec", "shell_exec", "run", { untrustedContentHint: true }],
			["write", "file_write", "run", { untrustedContentHint: true }],
			["link", "link_set", "run", {}],
			["plug", "cable_plug", "run", {}],
			["unplug", "cable_unplug", "run", {}],
			["mkswitch", "switch_add", "run", {}],
			["rmswitch", "switch_remove", "ask", { consequentialHint: true }],
			["cable", "switch_cable", "run", {}],
			["uncable", "switch_uncable", "run", {}],
			["vlan", "port_vlan", "run", {}],
			["trunk", "port_trunk", "run", {}],
			["stp", "switch_stp", "run", {}],
			["priority", "switch_priority", "run", {}],
			["cost", "port_cost", "run", {}],
			["topology", "topology_read", "run", { readOnlyHint: true }],
			["boot", "machines_boot", "run", {}],
			["reboot", "machines_reboot", "run", {}],
			["poweroff", "machines_poweroff", "run", {}],
			["checkpoint", "checkpoint_save", "run", {}],
			["restore", "checkpoint_restore", "ask", { consequentialHint: true }],
			["forget", "checkpoint_remove", "ask", { consequentialHint: true }],
			["help", "lab_help", "run", { readOnlyHint: true }],
		]);
		expect(registry.commands.filter((c) => c.danger).map((c) => c.name)).toEqual([
			"rm",
			"rmswitch",
			"restore",
			"forget",
		]);
	});
});

const word = fc.constantFrom("node1", "node2", "node3", "node*", "all", "node1,node3", "node3,node2");
const spaces = fc.constantFrom(" ", "  ");

/** Lines a person might type, in any option order and spacing. */
const lines = fc.oneof(
	fc
		.tuple(
			fc.integer({ min: 1, max: 4 }),
			fc.constantFrom("alpine", "debian"),
			fc.option(fc.constantFrom("--mem 128", "--mem 256", "--mem 1000")),
			fc.option(fc.constantFrom("--net switch0", "--net wan", "--no-net")),
			fc.option(fc.constantFrom("--extra-disk 1", "--extra-disk 64,1,1,2")),
			fc.boolean(),
		)
		.map(([n, image, mem, net, extra, swap]) => {
			const options = [mem, net, extra].filter((o) => o !== null);
			return ["spawn", n, image, ...(swap ? options.reverse() : options)].join(" ");
		}),
	fc.tuple(fc.constantFrom("up", "down"), word).map(([dir, w]) => `link ${dir} ${w}`),
	fc
		.tuple(fc.constantFrom("node1", "node2:eth0", "node3"), fc.constantFrom("wan", "wan:8", "switch0:2"))
		.map(([nic, to]) => `plug ${nic} ${to}`),
	fc.constantFrom("unplug node1", "unplug node3:eth0"),
	word.map((w) => `rm ${w}`),
	fc
		.tuple(fc.constantFrom("node1", "node2:sh1", "all", "node1:console,node3"), fc.string({ minLength: 1 }))
		.filter(([, command]) => command.trim() !== "" && !/[\r\n]/.test(command))
		.map(([t, command]) => `exec ${t} -- ${command}`),
	fc
		.tuple(fc.constantFrom("node1", "node2:sh1", "node3:console"), fc.constantFrom("", " --main", " --max"))
		.map(([t, mode]) => `focus ${t}${mode}`),
	fc
		.array(fc.constantFrom("icmp", "arp", "node1", "or", "port:2"), { maxLength: 4 })
		.map((w) => `capture ${w.join(" ")}`),
	fc.tuple(fc.constantFrom("reboot", "poweroff"), word).map(([verb, w]) => `${verb} ${w}`),
	fc.constantFrom("topology", "mkswitch", "mkswitch lan", "mkswitch switch7", "rmswitch wan"),
	fc.constantFrom("ls", "sh node1", "sh node3", "help", "help spawn", "help machines_spawn"),
	fc
		.tuple(
			fc.constantFrom("/etc/motd", String.raw`/a\ b`, String.raw`/a\\b`, "//x"),
			fc.constantFrom("", " --mode 600", " --owner root:adm --mode 755"),
			fc.string({ unit: "binary" }),
		)
		.map(([path, options, text]) => `write node2 ${path}${options} -- ${text}`),
);

describe("the round trip", () => {
	it("parses the canonical line back to the same arguments, for every verb", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("sh node2");
		await lab.run("mkswitch wan");
		fc.assert(
			fc.property(lines, spaces, (line, gap) => {
				const typed = line.replace(/ /, gap);
				const first = lab.parse(typed);
				fc.pre(!isLineError(first));
				if (isLineError(first)) return;
				const again = lab.parsed(first.line);
				expect(again.line).toBe(first.line);
				expect(again.args).toEqual(first.args);
			}),
		);
	});
});
