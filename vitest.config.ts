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
						include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
						exclude: [...configDefaults.exclude, BROWSER_TESTS],
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
					// Real kernels boot in real workers here, so the page needs what the app's build has.
					extends: true,
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
