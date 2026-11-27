import { availableParallelism } from "node:os";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import { chromiumExecutable } from "./test/support/chromium.ts";
import viteConfig from "./vite.config.ts";

const BROWSER_TESTS = "src/**/*.browser.test.ts";

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			projects: [
				{
					test: {
						name: "unit",
						include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "cli/**/*.test.ts"],
						exclude: [...configDefaults.exclude, BROWSER_TESTS],
						environment: "node",
					},
				},
				{
					test: {
						name: "integration",
						include: ["test/integration/**/*.test.ts"],
						globalSetup: ["test/integration/global-setup.ts"],
						// Processes start here, and a loaded machine starts them slowly.
						expect: { poll: { timeout: 15_000 } },
						environment: "node",
						testTimeout: 300_000,
						hookTimeout: 300_000,
						// A file's machines have a thread each, and some tests time what the switches do. With a file for
						// every processor but one, which is what the runner takes when it is told nothing, those tests ran
						// late: on 16 processors, one more file had most runs fail. A number here is taken as it is, so
						// the least of the two keeps a small machine at what it had.
						maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)),
						// Vitest runs projects with their own worker count in a group of their own, after the others.
						sequence: { groupOrder: 1 },
					},
				},
				{
					// Real kernels boot in real workers here, so the page needs what the app's build has.
					extends: true,
					// Bundled before the first test file loads: a dependency found mid-run makes Vite reload, and the
					// test iframes that were starting then fail to find their runner.
					optimizeDeps: {
						include: [
							"lit",
							"lit/directives/live.js",
							"lit/directives/ref.js",
							"lit/directives/repeat.js",
							"@lit/context",
							"@wterm/dom",
							"@wterm/ghostty",
							"axe-core",
						],
					},
					test: {
						name: "browser",
						include: [BROWSER_TESTS],
						testTimeout: 120_000,
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
	}),
);
