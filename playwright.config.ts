import { defineConfig, devices } from "@playwright/test";
import { chromiumExecutable } from "./test/support/chromium.ts";

const PORT = Number(process.env.E2E_PORT ?? 4173);

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
		// Never test a server something else started: it may be serving a stale build.
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
