/**
 * Whether `name` matches `glob`, whose only wildcard is `*`. Linear in the
 * lengths of both, with no backtracking regular expression for an agent's
 * `****…x` to stall the page on.
 */
export function globMatch(glob: string, name: string): boolean {
	let g = 0;
	let n = 0;
	let star = -1;
	let resume = 0;
	while (n < name.length) {
		if (g < glob.length && glob[g] === "*") {
			star = g++;
			resume = n;
		} else if (g < glob.length && glob[g] === name[n]) {
			g++;
			n++;
		} else if (star >= 0) {
			g = star + 1;
			n = ++resume;
		} else {
			return false;
		}
	}
	while (glob[g] === "*") g++;
	return g === glob.length;
}
