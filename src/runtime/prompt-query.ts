/**
 * busybox's line editor ends every prompt by asking where the cursor is
 * (`ESC[6n`). It reads keys sixteen bytes at a time, and when the terminal's
 * reply shares a read with what was typed next, it keeps the reply and drops
 * the rest: `echo a-$((40+2))` typed straight after the reply ran as
 * `40+2))`. The answer only corrects busybox's idea of the column when a
 * prompt starts mid-line, so the query that directly follows our prompt's
 * OSC 133;B mark is removed before the terminal sees it. A query anywhere
 * else, from a program the user runs, still reaches the terminal and is
 * answered.
 */

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const SEMICOLON = 0x3b;
/** `ESC ] 1 3 3 ; B`, any `;` parameters such as the boot's token, then BEL or `ESC \`. */
const MARK = [ESC, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x42];
/** `ESC [ 6 n` */
const QUERY = [ESC, 0x5b, 0x36, 0x6e];

/** A filter over one stream of terminal output. Sequences may split anywhere between chunks. */
export function createPromptQueryFilter(): (bytes: Uint8Array) => Uint8Array {
	let mark = 0;
	let stringTerminator = false;
	let params = false;
	/** -1 outside the window after a mark; otherwise how many query bytes are held back. */
	let held = -1;

	return (bytes) => {
		if (held < 0 && mark === 0 && !stringTerminator && !params && !bytes.includes(ESC)) return bytes;
		const out = new Uint8Array(bytes.length + QUERY.length);
		let n = 0;
		let dropped = false;
		for (const b of bytes) {
			if (held >= 0) {
				if (b === QUERY[held]) {
					held++;
					if (held === QUERY.length) {
						held = -1;
						dropped = true;
					}
					continue;
				}
				for (let i = 0; i < held; i++) out[n++] = QUERY[i] ?? 0;
				held = -1;
			}
			out[n++] = b;
			if (params) {
				if (b === BEL) {
					params = false;
					held = 0;
				} else if (b === ESC) {
					params = false;
					stringTerminator = true;
				}
				continue;
			}
			if (stringTerminator) {
				stringTerminator = false;
				if (b === BACKSLASH) {
					held = 0;
					continue;
				}
				mark = 1;
			}
			if (mark === MARK.length) {
				mark = 0;
				if (b === BEL) {
					held = 0;
					continue;
				}
				if (b === ESC) {
					stringTerminator = true;
					continue;
				}
				if (b === SEMICOLON) {
					params = true;
					continue;
				}
			}
			if (b === MARK[mark]) mark++;
			else mark = b === ESC ? 1 : 0;
		}
		return !dropped && n === bytes.length ? bytes : out.subarray(0, n);
	};
}
