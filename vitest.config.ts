import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts"],
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
		],
	},
});
