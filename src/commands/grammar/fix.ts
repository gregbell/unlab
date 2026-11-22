import type { Token } from "../types.ts";

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps each cost one. */
export function editDistance(a: string, b: string): number {
	const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				best = Math.min(best, rows[i - 2][j - 2] + 1);
			rows[i][j] = best;
		}
	}
	return rows[a.length][b.length];
}

/**
 * The line with the bad span of one token replaced, when exactly one expected
 * value is within edit distance 2 of it. Two or more near values are a guess,
 * so there is no fix.
 */
export function oneEditFix(
	line: string,
	token: Token,
	expected: readonly string[],
	part: { readonly start: number; readonly end: number } = { start: 0, end: token.text.length },
): string | undefined {
	const bad = token.text.slice(part.start, part.end);
	const near = [...new Set(expected)].filter((e) => e !== bad && editDistance(bad, e) <= 2);
	if (near.length !== 1) return undefined;
	return line.slice(0, token.start + part.start) + near[0] + line.slice(token.start + part.end);
}
