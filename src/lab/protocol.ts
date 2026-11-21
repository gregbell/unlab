// Messages between the page and a machine's worker. One worker per machine:
// a kernel owns its thread (it blocks in Atomics.wait while idle), so a busy
// machine must never be able to stall another one or the page.

export interface HostEntry {
	ip: string;
	name: string;
}

export interface VmConfig {
	id: string;
	name: string;
	/** This machine's address on the lab segment. */
	ip: string;
	prefixBits: number;
	mac: string;
	labCidr: string;
	/** The distro image bytes, shared with every machine using the same image. */
	image: ArrayBufferLike;
	/** Which image that is, for display. */
	distro: string;
	memoryMiB: number;
	hosts: HostEntry[];
	/** Give this machine a NAT uplink to the internet (needed by `apk add`). */
	internet: boolean;
	wispServers?: string[];
	cols: number;
	rows: number;
}

/** A shell on its own pty, beside the kernel console. */
export interface PtySpec {
	sid: number;
	cols: number;
	rows: number;
}

export type ToVm =
	| { type: "boot"; cfg: VmConfig }
	| { type: "frame"; frame: Uint8Array }
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "exec"; id: number; cmd: string; root?: boolean }
	| { type: "reconfigure"; name: string; ip: string; prefixBits: number; hosts: HostEntry[]; internet: boolean }
	| { type: "pty-open"; spec: PtySpec }
	| { type: "pty-data"; sid: number; data: string }
	| { type: "pty-resize"; sid: number; cols: number; rows: number }
	| { type: "pty-close"; sid: number }
	| { type: "stop" };

export type FromVm =
	| { type: "stage"; stage: string; detail?: string }
	| { type: "booted"; ms: number }
	| { type: "ready"; ms: number }
	| { type: "frame"; frame: Uint8Array }
	| { type: "console"; bytes: Uint8Array }
	| { type: "exec-result"; id: number; exitCode: number | null; stdout: string; stderr: string }
	| { type: "exited"; code: number; reason: string }
	| { type: "pty-ready"; sid: number; pid: number; pts: number }
	| { type: "pty-output"; sid: number; bytes: Uint8Array }
	| { type: "pty-exit"; sid: number; code: number | null; reason: string }
	| { type: "error"; message: string; fatal: boolean };
