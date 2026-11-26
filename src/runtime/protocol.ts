// Messages between the page and a machine's worker. One worker per machine:
// a kernel owns its thread (it blocks in Atomics.wait while idle), so a busy
// machine must never be able to stall another one or the page.

import type { FileOutcome, GuestFile } from "../commands/index.ts";
import type { Address, DiskCopy, Disks, HostEntry, Next, StopHow } from "../model/index.ts";
import type { NicNo } from "../net/index.ts";
import type { LinkTarget } from "./machine-link.ts";

export interface VmConfig {
	/** The machine's number, which its disks are kept under. */
	n: number;
	/** Its hostname. */
	name: string;
	/** One MAC for each NIC, eth0 first. */
	macs: readonly string[];
	/** What the lab sets on each NIC, eth0 first. */
	addresses: readonly (Address | null)[];
	/** The distro image bytes, shared with every machine using the same image. */
	image: ArrayBufferLike;
	memoryMiB: number;
	disks: Disks;
	/** Which set of them. */
	set: number;
	cpus?: number;
	hosts: readonly HostEntry[];
	/** Attach the gateway for signed distro repositories to eth0. */
	gateway: boolean;
	cols: number;
	rows: number;
	/** Carried in the guest prompt's OSC 133 marks; see shell-tracker.ts. */
	promptToken: string;
}

/** A shell on its own pty, beside the kernel console. */
export interface PtySpec {
	sid: number;
	cols: number;
	rows: number;
}

/** How a copy of a machine's disks goes. The last is `done` or `failed`, and one that failed has left nothing. */
export type CopyReport =
	| { readonly kind: "progress"; readonly percent: number }
	| { readonly kind: "done"; readonly bytes: number }
	/** One sentence. */
	| { readonly kind: "failed"; readonly reason: string };

/** A copy of disks that no guest has open, which a worker of its own makes. */
export interface CopyJob {
	readonly copy: DiskCopy;
	readonly why: "save" | "restore";
}

export type ToVm =
	| { type: "share-ssh"; port: MessagePort }
	| { type: "boot"; cfg: VmConfig }
	| { type: "frame"; nic: NicNo; frame: Uint8Array }
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "reconfigure"; name: string; hosts: readonly HostEntry[] }
	| { type: "pty-open"; spec: PtySpec }
	| { type: "pty-data"; sid: number; data: string }
	| { type: "pty-resize"; sid: number; cols: number; rows: number }
	| { type: "pty-close"; sid: number }
	/** Save the guest's disks as they are. Answered with `copy`s. */
	| { type: "checkpoint"; copy: DiskCopy }
	/** Put a file in the guest. Answered with `wrote`. */
	| { type: "write"; id: number; name: string; file: GuestFile }
	/** Where the CLI is, or null when there is no link. Taken at once, whatever the guest is doing. */
	| { type: "link"; target: LinkTarget | null }
	/** Stop the kernel, for a thread that is about to be dropped. */
	| { type: "stop" }
	/** Save every disk, once the guest has shut down when it is asked to. Answered with `released`. */
	| { type: "release"; how: Exclude<StopHow, "drop"> };

export type FromVm =
	| { type: "stage"; stage: string; detail?: string }
	| { type: "booted"; ms: number }
	| { type: "ready"; ms: number }
	| { type: "frame"; nic: NicNo; frame: Uint8Array }
	| { type: "console"; bytes: Uint8Array }
	/** The guest shut down by itself or as it was asked. */
	| { type: "halted"; next: Next }
	/** The kernel ended in any other way. */
	| { type: "exited"; code: number; reason: string }
	/** Nothing of the machine is left to save. `clean` when the guest shut down and every disk was saved. */
	| { type: "released"; clean: boolean }
	| { type: "copy"; report: CopyReport }
	| { type: "wrote"; id: number; outcome: FileOutcome }
	/** A NIC is gone from a guest that runs on. */
	| { type: "nic-lost"; nic: NicNo; reason: string }
	| { type: "pty-ready"; sid: number; pid: number; pts: number }
	| { type: "pty-output"; sid: number; bytes: Uint8Array }
	/** `lost` when the guest took the shell away, as it does when it goes down. */
	| { type: "pty-exit"; sid: number; code: number | null; reason: string; lost: boolean }
	| { type: "error"; message: string; fatal: boolean };
