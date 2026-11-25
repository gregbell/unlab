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
			["sh", "<machine>", "open another shell on a machine"],
			["link", "<up | down> <machines>", "plug or cut cables"],
			["capture", "<filter>", "filter the packet capture"],
			["focus", "<machine or session> [--main | --max]", "move the keyboard to a console"],
			["boot", "<machine>", "boot a failed machine again"],
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
			["link", "link_set", "run", {}],
		]);
		expect(registry.commands.filter((c) => c.danger).map((c) => c.name)).toEqual(["rm"]);
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
			fc.option(fc.constantFrom("--net switch0", "--no-net")),
			fc.option(fc.constantFrom("--extra-disk 1", "--extra-disk 64,1,1,2")),
			fc.boolean(),
		)
		.map(([n, image, mem, net, extra, swap]) => {
			const options = [mem, net, extra].filter((o) => o !== null);
			return ["spawn", n, image, ...(swap ? options.reverse() : options)].join(" ");
		}),
	fc.tuple(fc.constantFrom("up", "down"), word).map(([dir, w]) => `link ${dir} ${w}`),
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
	fc.constantFrom("ls", "sh node1", "sh node3"),
);

describe("the round trip", () => {
	it("parses the canonical line back to the same arguments, for every verb", async () => {
		const lab = storeLab();
		await lab.lab(3);
		await lab.run("sh node2");
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
