import { andList, type Disk, type LabState, type PlanError } from "../../model/index.ts";
import { addressStr, ip4str, nicName, subnetStr } from "../../net/index.ts";
import type { Selection } from "../grammar/slots.ts";

export { andList };

/** `1 shell`, `2 shells`. */
export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** `port 3`, `ports 3 and 4`. */
export function ports(list: readonly number[]): string {
	return `${list.length === 1 ? "port" : "ports"} ${andList(list)}`;
}

/** The preview's tail for machines a selection left out: `skipped node4: still booting`. */
export function skippedPart(skipped: Selection["skipped"]): string[] {
	return skipped.length === 0 ? [] : [`skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join(", ")}`];
}

/** A plan error from the model, as the verb says it. `ports` is what would make the switch's ports enough. */
export function planErrorSentence(error: PlanError, ports = "Remove a machine with rm to free its ports."): string {
	switch (error.kind) {
		case "no-ports":
			return `switch0 has ${count(error.free, "free port")}, and this takes ${error.wanted}. ${ports}`;
		case "no-room":
			return error.free === 0
				? "The lab has no room for another machine. Remove one with rm first."
				: `The lab has room for ${count(error.free, "more machine")}, not ${error.wanted}.`;
		case "unknown-image":
			return `No image called ${error.image}.`;
		case "name-taken":
			return `A machine is already called ${error.name}, so give another name with --name.`;
		case "address-taken":
			return `${ip4str(error.address.ip)} is already ${error.by.machine}'s, so give another address with --addr.`;
		case "address-overlap":
			return `--addr puts ${andList(error.nics.map(nicName))} in overlapping subnets, so give each its own, as in 10.1.0.1/24,10.2.0.1/24.`;
		case "address-gateway":
			return `--addr ${addressStr(error.address)} overlaps ${subnetStr(error.subnet)}, which the package gateway uses, so choose another subnet or add --no-gateway.`;
	}
}

/** `4 GiB`, or with several `/dev/wdb 4 GiB, /dev/wdc 1 GiB`. */
export function diskList(disks: readonly Disk[]): string {
	return disks.map(({ device, gib }) => (disks.length === 1 ? `${gib} GiB` : `${device} ${gib} GiB`)).join(", ");
}

export function imageLabel(lab: LabState, image: string): string {
	return lab.images.find((i) => i.name === image)?.label ?? image;
}
