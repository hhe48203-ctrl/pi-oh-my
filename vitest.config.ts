import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/**/*.test.ts"],
		environment: "node",
		timeout: 15000,
	},
});
