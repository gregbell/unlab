/**
 * A person said yes to one line. The private field makes the type nominal and
 * the class is never exported as a value, so `grantApproval` is the only way
 * to make one. index.ts does not re-export it: only the bar and the agent
 * module, which own the two confirmation surfaces, import this file.
 */
class ApprovalToken {
	readonly #line: string;
	constructor(line: string) {
		this.#line = line;
	}
	/** The approved line in bar grammar; a dangerous run checks it against its own. */
	get line(): string {
		return this.#line;
	}
}

export type Approval = ApprovalToken;

export function grantApproval(line: string): Approval {
	return new ApprovalToken(line);
}
