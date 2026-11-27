import { readFileSync } from "node:fs";
import type { Topology } from "../../src/commands/index.ts";

/** A recorded command set of `test/fixtures/scenarios`, as lines for the command bar, without its comments and blank lines. */
export function scenarioLines(name: string): string[] {
	const text = readFileSync(new URL(`../fixtures/scenarios/${name}.commands`, import.meta.url), "utf8");
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/** A line that waits until every machine is ready, as an agent waits on ls: a link needs ready machines, and exec types into them. */
export const waitsForMachines = (line: string): boolean => /^(link|exec) /.test(line);

/** A line that sets what a boot forgets, such as a route or forwarding in a guest. */
export const inGuests = (line: string): boolean => line.startsWith("exec ");

/**
 * Each port that a cable is in, from topology's data: what is at the other end, its link, what the port carries, the
 * cable's conditions, and the port's part in a spanning tree and its cost. A switch with spanning tree on, or a priority,
 * has a line of its own. Counters are left out, as they only grow.
 */
export function wiringOf(topology: Topology): string[] {
	return topology.switches.flatMap(({ name, ports, stp, priority }) => [
		...(stp || priority ? [`${name} stp ${stp ?? "off"} priority ${priority ?? "as new"}`] : []),
		...ports.flatMap(({ port, cable, vlan, stp, cost }) => {
			if (!cable) return [];
			const { to } = cable;
			const far = to.kind === "nic" ? `${to.machine}:${to.nic}` : `${to.switch}:${to.port}`;
			const tree = `${stp ? ` stp ${stp.role} ${stp.state}` : ""}${cost ? ` cost ${cost}` : ""}`;
			return [
				`${name}:${port} ${far} ${cable.link} ${JSON.stringify(vlan)} ${JSON.stringify(cable.conditions)}${tree}`,
			];
		}),
	]);
}

/** What three-subnets.commands wires: the routers' NICs in VLANs 10 and 20 on core, the trunk of both at port 8 of each switch, and the lossy cable of r2's eth1. */
export const THREE_SUBNETS_WIRING = [
	'core:1 r1:eth0 up {"mode":"access","vlan":10} {}',
	'core:2 r1:eth1 up {"mode":"access","vlan":20} {}',
	'core:8 edge:8 up {"mode":"trunk","allowed":[10,20],"native":1} {}',
	'edge:1 alice:eth0 up {"mode":"access","vlan":10} {}',
	'edge:2 r2:eth0 up {"mode":"access","vlan":20} {}',
	'edge:3 r2:eth1 up {"mode":"access","vlan":30} {"loss":"10%"}',
	'edge:4 bob:eth0 up {"mode":"access","vlan":30} {}',
	'edge:8 core:8 up {"mode":"trunk","allowed":[10,20],"native":1} {}',
];
