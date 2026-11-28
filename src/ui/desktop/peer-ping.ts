import type { Machine, MachineName } from "../../model/index.ts";
import { ip4str, subnetsOverlap } from "../../net/index.ts";

/** Pick one address per ready peer, preferring a subnet shared with the sending machine. */
export function peerPing(name: MachineName, machines: readonly Machine[]) {
	const addresses = (of: Machine | undefined) => of?.spec.nics.flatMap((nic) => nic.address ?? []) ?? [];
	const own = addresses(machines.find((machine) => machine.name === name));
	const peers = machines.flatMap((machine) => {
		if (machine.life.phase !== "ready" || machine.name === name) return [];
		const theirs = addresses(machine);
		const address = theirs.find((a) => own.some((mine) => subnetsOverlap(a, mine))) ?? theirs[0];
		return address ? [{ name: machine.name, ip: ip4str(address.ip) }] : [];
	});
	return {
		label: peers.length === 1 ? `Ping ${peers[0].name}` : "Ping peers",
		line: peers.length ? `exec ${name} -- ${peers.map(({ ip }) => `ping -c 3 ${ip}`).join("; ")}` : null,
	};
}
