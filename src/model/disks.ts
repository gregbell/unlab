import type { GiB, MachineSpec } from "./types.ts";

export const MAX_EXTRA_DISKS = 4;
export const MAX_EXTRA_GIB = 64;

export function parseGiB(size: unknown): GiB | null {
	return typeof size === "number" && Number.isInteger(size) && size >= 1 && size <= MAX_EXTRA_GIB
		? (size as GiB)
		: null;
}

/** wda is the image, which no one writes. */
const DEVICES = ["/dev/wdb", "/dev/wdc", "/dev/wdd", "/dev/wde", "/dev/wdf"] as const;
export type Device = (typeof DEVICES)[number];

export interface Disk {
	/** What the guest calls it. */
	readonly device: Device;
	readonly gib: number;
}

/** Every disk the machine keeps, the root's first. */
export function disksOf({ disks }: Pick<MachineSpec, "disks">): readonly Disk[] {
	return [Number(disks.root), ...disks.extra].map((size, i) => ({ device: DEVICES[i], gib: size }));
}
