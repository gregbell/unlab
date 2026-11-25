import type { LabState, MachineName, RailRow } from "../../model/index.ts";
import { ip4str, subnetsOverlap } from "../../net/index.ts";

/** Pick one address per ready peer, preferring a subnet shared with the sending machine. */
export function peerPing(name: MachineName, machines: LabState["machines"], rail: readonly RailRow[]) {
	const addresses = (of: MachineName) => machines[of]?.spec.nics.flatMap((nic) => nic.address ?? []) ?? [];
	const own = addresses(name);
	const peers = rail.flatMap((row) => {
		if (row.phase !== "ready" || row.name === name) return [];
		const theirs = addresses(row.name);
		const address = theirs.find((a) => own.some((mine) => subnetsOverlap(a, mine))) ?? theirs[0];
		return address ? [{ name: row.name, ip: ip4str(address.ip) }] : [];
	});
	return {
		label: peers.length === 1 ? `Ping ${peers[0].name}` : "Ping peers",
		line: peers.length ? `exec ${name} -- ${peers.map(({ ip }) => `ping -c 3 ${ip}`).join("; ")}` : null,
	};
}
