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
	/**
	 * A prompt is showing that a typed-ahead line should follow, and the line's
	 * Enter has not been echoed. A shell that has the line echoes it at once, so
	 * a session that stays quiet like this is really waiting at its prompt.
	 */
	readonly expectsTypedAhead: boolean;
	/** The session stayed quiet: the typed-ahead lines were read by a program, and the shell is at its prompt. */
	settle(): readonly ShellEvent[];
	/**
	 * From now on, believe only marks carrying `unlab=<token>`: a new boot's
	 * prompt. Any program can print `ESC]133;D;0`, but none can know this.
	 * Starts over at unknown, because a new boot is a new shell.
	 */
	expectToken(token: string): void;
}

const ESC = 0x1b;
const BEL = 0x07;
const LF = 0x0a;
const CAN = 0x18;
const SUB = 0x1a;
const BACKSLASH = 0x5c;
const OSC_INTRODUCER = 0x5d;

/** `133;D;255;unlab=` and a sixteen-digit token fit. A longer OSC is not one of ours. */
const KEPT = 48;
const NONE: readonly ShellEvent[] = Object.freeze([]);

type ScanState = "ground" | "esc" | "osc" | "osc-esc";

export function createShellTracker(): ShellTracker {
	let phase: ShellPhase = "unknown";
	/** While running: the submitted line's Enter has been echoed, so the next prompt is the command's end. */
	let echoed = false;
	/**
	 * Lines submitted while a command ran. The shell runs each as soon as the
	 * prompt before it appears, so that prompt starts a command, not a wait.
	 * When a program read the line itself, this overcounts, and the shell reads
	 * as running until `settle`: the safe side.
	 */
	let queued = 0;
	/** The command that is running is a typed-ahead line, if there was one. */
	let typedAhead = false;
	let token: string | null = null;
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

	/** A, B or D: the shell is showing a prompt. */
	const prompted = (code: number | null, at: number) => {
		if (phase === "running") {
			if (!echoed) return;
			emit({ kind: "finished", exitCode: code, at });
			if (queued > 0) {
				queued--;
				echoed = false;
				typedAhead = true;
				return;
			}
		}
		enter("prompt");
	};

	const expectsTypedAhead = () => phase === "running" && typedAhead && !echoed;

	const sequenceEnded = (at: number) => {
		state = "ground";
		if (length > KEPT) return;
		const [osc, kind, ...params] = String.fromCharCode(...body.subarray(0, length)).split(";");
		if (osc !== "133") return;
		if (token !== null && !params.includes(`unlab=${token}`)) return;
		switch (kind) {
			case "A":
			case "B":
				prompted(null, at);
				return;
			case "C":
				echoed = true;
				enter("running");
				return;
			case "D": {
				const code = params[0];
				prompted(code !== undefined && /^\d{1,3}$/.test(code) ? Number(code) : null, at);
				return;
			}
		}
	};

	return {
		get phase() {
			return phase;
		},

		get expectsTypedAhead() {
			return expectsTypedAhead();
		},

		settle() {
			if (!expectsTypedAhead()) return NONE;
			phase = "prompt";
			queued = 0;
			return [{ kind: "phase", phase: "prompt" }];
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

		expectToken(next) {
			token = next;
			phase = "unknown";
			echoed = false;
			queued = 0;
			typedAhead = false;
		},

		submitted() {
			if (phase === "running") queued++;
			if (phase !== "prompt") return NONE;
			phase = "running";
			echoed = false;
			typedAhead = false;
			return [{ kind: "phase", phase: "running" }];
		},
	};
}
