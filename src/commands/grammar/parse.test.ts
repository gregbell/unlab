import { describe, expect, it } from "vitest";
import { parseLine } from "../index.ts";
import { labWith } from "../testing/lab.ts";
import { parsedOk, toyRegistry } from "../testing/verbs.ts";

const lab = labWith([
	{ n: 1 },
	{ n: 2, shells: 1 },
	{ n: 3, link: "cut" },
	{ n: 4, phase: "booting" },
	{ n: 5, phase: "failed" },
]);
const threeReady = labWith([{ n: 1 }, { n: 2 }, { n: 3 }]);
const { registry } = toyRegistry(lab);
const parse = (line: string, state = lab) => parseLine(registry, line, state);
const args = (line: string, state = lab) => parsedOk(parse(line, state)).args;

describe("verbs", () => {
	it("offers the one close verb as the fix for a misspelt verb", () => {
		expect(parse("spwn 2 alpine")).toEqual({
			message: "No verb is called spwn, so use spawn, rm, ls, exec, link, capture, focus or boot. Nothing was changed.",
			token: 0,
			fix: "spawn 2 alpine",
		});
	});

	it("asks for a verb on an empty line", () => {
		expect(parse("  ")).toEqual({
			message: "Type a verb first: spawn, rm, ls, exec, link, capture, focus, boot. Nothing was changed.",
		});
	});
});

describe("choice", () => {
	it("reads one of its words", () => {
		expect(args("link up node1")).toMatchObject({ dir: "up" });
	});

	it("says what it wants and offers the near word as the fix", () => {
		expect(parse("link dwon node3")).toEqual({
			message: "link wants up or down here, not dwon. Nothing was changed.",
			token: 1,
			fix: "link down node3",
		});
	});
});

describe("count", () => {
	it("reads a positive whole number", () => {
		expect(args("spawn 2 alpine")).toMatchObject({ count: 2 });
	});

	it.each(["two", "0", "-1", "2.5", "1e3"])("refuses %s", (bad) => {
		expect(parse(`spawn ${bad} alpine`)).toMatchObject({
			message: `spawn wants a count such as 2 here, not ${bad}. Nothing was changed.`,
			token: 1,
		});
	});
});

describe("image", () => {
	it("reads an image from the lab's manifest", () => {
		expect(args("spawn 1 debian")).toMatchObject({ image: "debian" });
	});

	it("names the images there are and fixes a near miss", () => {
		expect(parse("spawn 2 alpne")).toEqual({
			message: "No image is called alpne, so use alpine or debian. Nothing was changed.",
			token: 2,
			fix: "spawn 2 alpine",
		});
	});
});

describe("options", () => {
	it("fills left-out options with their defaults and says which were assumed", () => {
		const line = parsedOk(parse("spawn 2 alpine"));
		expect(line.args).toEqual({ count: 2, image: "alpine", mem: 256, net: "switch0" });
		expect(line.assumed).toEqual(["--mem 256", "--net switch0"]);
	});

	it("reads an option's value and leaves it out of the assumed list", () => {
		const line = parsedOk(parse("spawn 2 alpine --mem 512"));
		expect(line.args).toMatchObject({ mem: 512 });
		expect(line.assumed).toEqual(["--net switch0"]);
	});

	it("takes options anywhere after the verb", () => {
		expect(args("spawn --no-net 2 --mem 128 alpine")).toEqual({ count: 2, image: "alpine", mem: 128, net: "none" });
	});

	it("wants a value after a valued flag", () => {
		expect(parse("spawn 2 alpine --mem")).toEqual({
			message: "spawn wants a size in MiB after --mem. Nothing was changed.",
			token: 3,
		});
		expect(parse("spawn 2 alpine --mem lots")).toMatchObject({
			message: "spawn wants a size in MiB after --mem, not lots. Nothing was changed.",
			token: 4,
		});
	});

	it("fixes a misspelt flag", () => {
		expect(parse("spawn 2 alpine --mme 512")).toEqual({
			message: "spawn has no option --mme, so use --mem, --net or --no-net. Nothing was changed.",
			token: 3,
			fix: "spawn 2 alpine --mem 512",
		});
	});

	it("refuses both sides of an exclusive group, and a flag given twice", () => {
		expect(parse("spawn 2 alpine --net switch0 --no-net")).toEqual({
			message: "spawn takes --net or --no-net, not both. Nothing was changed.",
			token: 5,
		});
		expect(parse("spawn 2 alpine --mem 1 --mem 2")).toEqual({
			message: "spawn takes --mem once. Nothing was changed.",
			token: 5,
		});
	});

	it("leaves out options that no flag can say, such as focus's plain mode", () => {
		const line = parsedOk(parse("focus node1"));
		expect(line.args).toEqual({ target: "node1", mode: "plain" });
		expect(line.assumed).toEqual([]);
	});
});

describe("argument count", () => {
	it("names the missing argument", () => {
		expect(parse("spawn 2")).toEqual({ message: "spawn needs an image such as alpine. Nothing was changed." });
	});

	it("points at the first extra token", () => {
		expect(parse("link down node1 node2")).toEqual({
			message: "link takes <up | down> <machines>, so leave out node2. Nothing was changed.",
			token: 3,
		});
		expect(parse("ls foo")).toMatchObject({
			message: "ls takes no arguments, so leave out foo. Nothing was changed.",
		});
	});
});

describe("machines", () => {
	it("expands all to the machines in the verb's phases and reports the rest as skipped", () => {
		expect(args("link down all")).toEqual({
			dir: "down",
			targets: {
				machines: ["node1", "node2", "node3"],
				skipped: [
					{ name: "node4", reason: "still booting" },
					{ name: "node5", reason: "failed" },
				],
				written: "all",
			},
		});
	});

	it("expands a glob the same way", () => {
		expect(args("link down node*")).toMatchObject({
			targets: {
				machines: ["node1", "node2", "node3"],
				skipped: [
					{ name: "node4", reason: "still booting" },
					{ name: "node5", reason: "failed" },
				],
				written: "node*",
			},
		});
	});

	it("skips a named machine in another phase and keeps the rest of the list", () => {
		expect(args("link up node4,node1,node1")).toMatchObject({
			targets: { machines: ["node1"], skipped: [{ name: "node4", reason: "still booting" }] },
		});
	});

	it("accepts the phases a verb declares", () => {
		const removing = labWith([
			{ n: 1 },
			{ n: 4, phase: "booting" },
			{ n: 5, phase: "failed" },
			{ n: 6, phase: "removing" },
		]);
		expect(args("rm all", removing)).toMatchObject({
			targets: { machines: ["node1", "node4", "node5"], skipped: [{ name: "node6", reason: "being removed" }] },
		});
	});

	it("refuses when nothing is left to act on", () => {
		expect(parse("link down node4")).toEqual({
			message: "link wants a ready machine here, and node4 is still booting. Nothing was changed.",
			token: 2,
		});
	});

	it("lists the machines there are and offers no fix when several are as close", () => {
		expect(parse("link down node7", threeReady)).toEqual({
			message: "No machine is called node7, so use node1, node2 or node3. Nothing was changed.",
			token: 2,
		});
	});

	it("fixes one name inside a list without touching the others", () => {
		const twelve = labWith([{ n: 1 }, { n: 12 }]);
		expect(parse("link down node12,nod", twelve)).toEqual({
			message: "No machine is called nod, so use node1 or node12. Nothing was changed.",
			token: 2,
			fix: "link down node12,node1",
		});
	});

	it("says when a glob matches nothing", () => {
		expect(parse("link down web*")).toMatchObject({
			message: "No machine matches web*, so use node1, node2, node3, node4 or node5. Nothing was changed.",
			token: 2,
		});
	});

	it("says when the lab is empty", () => {
		expect(parse("link down node1", labWith([]))).toMatchObject({
			message: "No machine is called node1, and the lab has none yet, so spawn one first. Nothing was changed.",
		});
	});
});

describe("machine", () => {
	it("reads one machine in the verb's phases", () => {
		expect(args("boot node5")).toEqual({ machine: "node5" });
	});

	it("refuses a machine in another phase, saying why", () => {
		expect(parse("boot node1")).toEqual({
			message: "boot wants an off or failed machine here, and node1 is ready. Nothing was changed.",
			token: 1,
		});
	});
});

describe("machine or session", () => {
	it("reads a machine or one of its sessions", () => {
		expect(args("focus node2")).toMatchObject({ target: "node2" });
		expect(args("focus node2:sh1 --max")).toEqual({ target: "node2:sh1", mode: "max" });
		expect(args("focus node2:console --main")).toEqual({ target: "node2:console", mode: "main" });
	});

	it("names the sessions a machine has and fixes a near one", () => {
		expect(parse("focus node2:sh9")).toEqual({
			message: "node2 has no session called sh9, so use console or sh1. Nothing was changed.",
			token: 1,
			fix: "focus node2:sh1",
		});
	});
});

describe("free text and passthrough", () => {
	it("joins the remaining tokens as free text, empty when there are none", () => {
		expect(args("capture arp  or icmp")).toEqual({ filter: "arp or icmp" });
		expect(args("capture")).toEqual({ filter: "" });
	});

	it("passes everything after -- through untouched", () => {
		expect(args("exec all -- ping  -c1 node3 -- x")).toMatchObject({ command: "ping  -c1 node3 -- x" });
	});

	it("wants a command after --", () => {
		expect(parse("exec all")).toEqual({ message: "exec wants a command after --. Nothing was changed." });
		expect(parse("exec all --")).toEqual({ message: "exec wants a command after --. Nothing was changed.", token: 2 });
	});

	it("refuses control characters after --, which the shell would act on unseen", () => {
		for (const control of ["\x7f", "\x15", "\t", "\x1b", "\x03", "\x0f"]) {
			expect(parse(`exec all -- rm -rf /tmp/safe${control}`)).toMatchObject({
				message: "exec wants a command of printable characters after --. Nothing was changed.",
			});
		}
		expect(args("exec all -- printf '%s\\n' ok")).toMatchObject({ command: "printf '%s\\n' ok" });
	});

	it("refuses -- on a verb that takes nothing after it", () => {
		expect(parse("link down node1 -- x")).toEqual({
			message: "link takes nothing after --, so leave it out. Nothing was changed.",
			token: 3,
		});
	});
});
