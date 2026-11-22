import { describe, expect, it } from "vitest";
import { checkImports } from "./check-imports.ts";

const file = (path: string, ...imports: string[]) => ({ path, text: imports.join("\n") });

describe("checkImports", () => {
	it("allows a layer to import a permitted layer through its index", () => {
		expect(checkImports([file("src/commands/define.ts", `import { update } from "../model/index.ts";`)])).toEqual([]);
	});

	it("rejects a layer importing one it may not", () => {
		const v = checkImports([file("src/ui/rail/row.ts", `import { createEngine } from "../../runtime/index.ts";`)]);
		expect(v).toEqual([expect.objectContaining({ reason: "ui may not import runtime" })]);
	});

	it("rejects a deep import past another layer's index", () => {
		const v = checkImports([file("src/commands/define.ts", `import { planSpawn } from "../model/machines.ts";`)]);
		expect(v).toEqual([expect.objectContaining({ reason: "import model through src/model/index.ts" })]);
	});

	it("allows type-only imports where the rule says types, and only those", () => {
		const typeOnly = file("src/ui/capture/list.ts", `import type { CaptureView } from "../../capture/index.ts";`);
		const value = file("src/ui/capture/list.ts", `import { createCaptureLog } from "../../capture/index.ts";`);
		expect(checkImports([typeOnly])).toEqual([]);
		expect(checkImports([value])).toHaveLength(1);
	});

	it("ignores imports inside one layer and package imports", () => {
		const f = file("src/model/update.ts", `import { tile } from "./tiling.ts";`, `import { html } from "lit";`);
		expect(checkImports([f])).toEqual([]);
	});

	it("lets the bar and the agent mint approvals, and nobody else", () => {
		const bar = file("src/ui/command-bar/model.ts", `import { grantApproval } from "../../commands/approval.ts";`);
		const rail = file("src/ui/rail/details.ts", `import { grantApproval } from "../../commands/approval.ts";`);
		expect(checkImports([bar])).toEqual([]);
		expect(checkImports([rail])).toHaveLength(1);
	});

	it("covers re-exports as well as imports", () => {
		const v = checkImports([file("src/net/index.ts", `export { update } from "../model/index.ts";`)]);
		expect(v).toEqual([expect.objectContaining({ reason: "net may not import model" })]);
	});
});
