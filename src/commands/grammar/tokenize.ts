import type { Token, Tokenized } from "../types.ts";

export function tokenize(line: string): Tokenized {
	const tokens: Token[] = [];
	for (const match of line.matchAll(/\S+/g)) {
		const token = { text: match[0], start: match.index, end: match.index + match[0].length };
		tokens.push(token);
		if (token.text === "--") {
			return { line, tokens, passthrough: line.slice(token.end).replace(/^\s+/, "") };
		}
	}
	return { line, tokens, passthrough: null };
}
