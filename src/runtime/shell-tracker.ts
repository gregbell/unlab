// What a session's shell is doing, read from the OSC 133 marks the guest's
// prompt prints (guest.ts installs it): `D;<exit>` then `A` before each prompt
// and `B` after it. The prompt never prints C, so "running" starts when a line
// is submitted at a prompt and ends at the next prompt.
//
// A shell also reprints its prompt, marks included, when its terminal is
// resized or cleared, and that reprint can still be on its way when a line is
// submitted. So a prompt ends a command only after a line feed has come back
// since the submission: the terminal's echo of Enter. A reprint carries none.
//
// The scanner sees raw output bytes and never depends on the renderer, so exec
// learns exit codes for sessions nobody is looking at.

export type ShellPhase = "unknown" | "prompt" | "running";

export type ShellEvent =
	/** Only when the phase changes. */
	| { readonly kind: "phase"; readonly phase: "prompt" | "running" }
	/**
	 * A submitted line has returned. `exitCode` is null when the prompt did not
	 * say. `at` is how many bytes of the scanned chunk had been read when the
	 * mark ended: output before it belongs to the command, output after it is
	 * the next prompt.
	 */
	| { readonly kind: "finished"; readonly exitCode: number | null; readonly at: number };

export interface ShellTracker {
	readonly phase: ShellPhase;
	/** Feed the session's output in order. Sequences may be split across calls. Usually returns nothing. */
	scan(bytes: Uint8Array): readonly ShellEvent[];
	/** A line was sent to the session. It only counts while the shell is at a prompt. */
	submitted(): readonly ShellEvent[];
}

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const CAN = 0x18;
const SUB = 0x1a;
const BACKSLASH = 0x5c;
const OSC_INTRODUCER = 0x5d;
const SEMICOLON = 0x3b;
const ZERO = 0x30;
const NINE = 0x39;

const PREFIX = [0x31, 0x33, 0x33, SEMICOLON] as const;
/** `133;D;255` is nine bytes. Anything past this is options the tracker does not read. */
const KEPT = 16;
const NONE: readonly ShellEvent[] = Object.freeze([]);

type ScanState = "ground" | "esc" | "osc" | "osc-esc";

export function createShellTracker(): ShellTracker {
	let phase: ShellPhase = "unknown";
	/** While running: the submitted line's Enter has been echoed, so the next prompt is the command's end. */
	let echoed = false;
	let state: ScanState = "ground";
	const body = new Uint8Array(KEPT);
	let length = 0;
	let found: ShellEvent[] | null = null;

	const emit = (e: ShellEvent) => {
		found ??= [];
		found.push(e);
	};

	const enter = (next: "prompt" | "running") => {
		if (phase === next) return;
		phase = next;
		emit({ kind: "phase", phase: next });
	};

	const exitCode = (): number | null => {
		if (body[5] !== SEMICOLON) return null;
		let code: number | null = null;
		for (let i = 6; i < Math.min(length, KEPT); i++) {
			const digit = body[i];
			if (digit === SEMICOLON) break;
			if (digit < ZERO || digit > NINE) return null;
			code = (code ?? 0) * 10 + (digit - ZERO);
		}
		return code;
	};

	/** A, B or D: the shell is showing a prompt. */
	const prompted = (code: number | null, at: number) => {
		if (phase === "running") {
			if (!echoed) return;
			emit({ kind: "finished", exitCode: code, at });
		}
		enter("prompt");
	};

	const sequenceEnded = (at: number) => {
		state = "ground";
		if (length < 5 || PREFIX.some((byte, i) => body[i] !== byte)) return;
		if (length > 5 && body[5] !== SEMICOLON) return;
		switch (String.fromCharCode(body[4])) {
			case "A":
			case "B":
				prompted(null, at);
				return;
			case "C":
				echoed = true;
				enter("running");
				return;
			case "D":
				prompted(exitCode(), at);
				return;
		}
	};

	return {
		get phase() {
			return phase;
		},

		scan(bytes) {
			found = null;
			let i = 0;
			while (i < bytes.length) {
				if (state === "ground") {
					const esc = bytes.indexOf(ESC, i);
					const end = esc < 0 ? bytes.length : esc;
					if (phase === "running" && !echoed) {
						const lf = bytes.indexOf(LF, i);
						if (lf >= 0 && lf < end) echoed = true;
					}
					if (esc < 0) break;
					state = "esc";
					i = esc + 1;
					continue;
				}
				const byte = bytes[i++];
				if (state === "esc") {
					if (byte === OSC_INTRODUCER) {
						state = "osc";
						length = 0;
					} else if (byte !== ESC) {
						state = "ground";
					}
				} else if (state === "osc") {
					if (byte === BEL) sequenceEnded(i);
					else if (byte === ESC) state = "osc-esc";
					else if (byte === CAN || byte === SUB) state = "ground";
					else {
						if (length < KEPT) body[length] = byte;
						length++;
					}
				} else if (byte === BACKSLASH) {
					sequenceEnded(i);
				} else {
					// Any other escape abandons the OSC and starts a sequence of its own.
					state = "esc";
					i--;
				}
			}
			const events = found ?? NONE;
			found = null;
			return events;
		},

		submitted() {
			if (phase !== "prompt") return NONE;
			phase = "running";
			echoed = false;
			return [{ kind: "phase", phase: "running" }];
		},
	};
}
