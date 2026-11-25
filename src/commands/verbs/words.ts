import {
	andList,
	type Disk,
	type LabState,
	type PlanError,
	type PortNo,
	type PortRef,
	type SwitchName,
	type SwitchPlanError,
	switchLabel,
} from "../../model/index.ts";
import { addressStr, ip4str, nicName, subnetStr } from "../../net/index.ts";
import { list, type Selection } from "../grammar/slots.ts";

export { andList };

export function noVerb(text: string, names: readonly string[]): string {
	return `No verb is called ${text}, so use ${list(names, "or")}.`;
}

/** `1 shell`, `2 shells`. */
export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** `port 3`, `ports 3 and 4`. */
export function ports(list: readonly number[]): string {
	return `${list.length === 1 ? "port" : "ports"} ${andList(list)}`;
}

function bySwitch(refs: readonly PortRef[]): readonly (readonly [SwitchName, readonly PortNo[]])[] {
	const grouped = Map.groupBy(refs, (ref) => ref.switch);
	return [...grouped].map(([on, held]) => [on, held.map(({ port }) => port)]);
}

/** `port 3`, `ports 3 and 4`, or `switch0 port 3 and lan ports 1 and 2` in a lab with several switches. */
export function portsOn(lab: LabState, refs: readonly PortRef[]): string {
	return andList(
		bySwitch(refs).map(([on, held]) => {
			const label = switchLabel(lab, on);
			return label === null ? ports(held) : `${label} ${ports(held)}`;
		}),
	);
}

/** A port as a tool returns it, with its switch in a lab that has several. */
export function portOf(
	lab: LabState,
	ref: PortRef | null | undefined,
): { readonly switch?: SwitchName; readonly port: PortNo | null } {
	if (!ref) return { port: null };
	const label = switchLabel(lab, ref.switch);
	return label === null ? { port: ref.port } : { switch: label, port: ref.port };
}

/** `plugged into switch0 on ports 2 and 3`, or `unplugged`. */
export function pluggedInto(refs: readonly PortRef[]): string {
	const where = bySwitch(refs).map(([on, list]) => `${on} on ${ports(list)}`);
	return where.length === 0 ? "unplugged" : `plugged into ${andList(where)}`;
}

/** `Ports 2 and 3 on switch0 free up.` */
export function portsFree(refs: readonly PortRef[]): string[] {
	if (refs.length === 0) return [];
	const [first, ...rest] = bySwitch(refs).map(([on, list]) => `${ports(list)} on ${on}`);
	const which = andList([first.replace("p", "P"), ...rest]);
	return [`${which} ${refs.length === 1 ? "frees" : "free"} up.`];
}

/** The preview's tail for machines a selection left out: `skipped node4: still booting`. */
export function skippedPart(skipped: Selection["skipped"]): string[] {
	return skipped.length === 0 ? [] : [`skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join(", ")}`];
}

/** Whoever has the name, and what to do about it. */
export function nameTaken(
	{ name, by }: Extract<PlanError | SwitchPlanError, { kind: "name-taken" }>,
	how = "",
): string {
	return `A ${by} is already called ${name}, so give another name${how}.`;
}

/** A plan error from the model, as the verb says it. `ports` is what would make a switch's ports enough. */
export function planErrorSentence(error: PlanError, ports = "remove a machine with rm to free its ports"): string {
	switch (error.kind) {
		case "no-ports":
			return `${error.switch} has ${count(error.free, "free port")} and this takes ${error.wanted}, so ${ports}.`;
		case "no-room":
			return error.free === 0
				? "The lab has no room for another machine, so remove one with rm first."
				: `The lab has room for ${count(error.free, "more machine")}, not ${error.wanted}.`;
		case "unknown-image":
			return `No image is called ${error.image}, so spawn another machine from an image that the lab has.`;
		case "name-taken":
			return nameTaken(error, " with --name");
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
