import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { chromium } from "playwright";

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

const PORT = 4173;

export default defineConfig({
	testDir: "e2e",
	timeout: 120_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "github" : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				launchOptions: { executablePath: chromiumExecutable() },
			},
		},
	],
	webServer: {
		command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
