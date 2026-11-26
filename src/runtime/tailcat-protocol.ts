import type { SshKeys } from "../streams/index.ts";

export type ToTailcat =
	| { type: "start" }
	| { type: "stop" }
	| { type: "read"; id: number }
	| { type: "write"; id: number; data: Uint8Array }
	| { type: "close"; id: number };

export type FromTailcat =
	| { type: "ready"; code: string; hostKey: string }
	| { type: "open"; id: number }
	| { type: "data"; id: number; data: Uint8Array }
	| { type: "eof"; id: number }
	| { type: "written"; id: number }
	| { type: "close"; id: number }
	| { type: "error"; message: string };

export type ToSharedGuest =
	| { type: "configure"; keys: SshKeys; programs: string }
	| { type: "stop" }
	| Exclude<FromTailcat, { type: "ready" | "error" }>;
export type FromSharedGuest =
	| Exclude<ToTailcat, { type: "start" }>
	| { type: "configured" }
	| { type: "error"; message: string };
