import { existsSync } from "node:fs";
import { playwright } from "@vitest/browser-playwright";
import { chromium } from "playwright";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Playwright's downloaded Chromium cannot run on hosts without a standard
 * dynamic loader (NixOS among them), so fall back to a system Chromium there.
 * CHROMIUM_PATH overrides both.
 */
function chromiumExecutable(): string | undefined {
	if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
	if (existsSync(chromium.executablePath())) return undefined;
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = `${dir}/chromium`;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
					exclude: [...configDefaults.exclude, "src/**/*.browser.test.ts"],
					environment: "node",
				},
			},
			{
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					environment: "node",
					testTimeout: 300_000,
					hookTimeout: 300_000,
				},
			},
			{
				test: {
					name: "browser",
					include: ["src/**/*.browser.test.ts"],
					browser: {
						enabled: true,
						headless: true,
						provider: playwright({ launchOptions: { executablePath: chromiumExecutable() } }),
						instances: [{ browser: "chromium" }],
					},
				},
			},
		],
	},
});
