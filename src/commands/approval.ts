import type { ConfirmText } from "./types.ts";

/**
 * A person said yes to one line, for what they read of it. The private field makes the type nominal and
 * the class is never exported as a value, so `grantApproval` is the only way
 * to make one. index.ts does not re-export it: only the bar and the agent
 * module, which own the two confirmation surfaces, import this file.
 */
class ApprovalToken {
	readonly #line: string;
	readonly #asked: ConfirmText;
	constructor(line: string, asked: ConfirmText) {
		this.#line = line;
		this.#asked = asked;
	}
	/** The approved line in bar grammar; a dangerous run checks it against its own. */
	get line(): string {
		return this.#line;
	}
	/** What they were asked; a dangerous run checks that it would still ask it. */
	get asked(): ConfirmText {
		return this.#asked;
	}
}

export type Approval = ApprovalToken;

export function grantApproval(line: string, asked: ConfirmText): Approval {
	return new ApprovalToken(line, asked);
}
