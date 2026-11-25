import type { DiskSets, GiB, MachineSpec } from "./types.ts";

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

/** The machine's disks and its checkpoints before anything has been saved or restored. */
export const FIRST_SETS: DiskSets = { live: 0, next: 1, checkpoints: [] };

/** `12.5 MiB`. */
export function sizeText(bytes: number): string {
	return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}
