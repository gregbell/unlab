import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Playwright's downloaded Chromium cannot run on hosts without a standard
 * dynamic loader (NixOS among them), so fall back to a system Chromium there.
 * CHROMIUM_PATH overrides both. Undefined means Playwright's own binary.
 */
export function chromiumExecutable(): string | undefined {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	if (existsSync(chromium.executablePath())) return undefined;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = `${dir}/chromium`;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}
