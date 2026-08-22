import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
	testDir: "./tests/e2e",
	outputDir: "test-results",
	fullyParallel: false,
	retries: 0,
	reporter: "line",
	use: {
		baseURL: "http://127.0.0.1:4317",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
	],
	webServer: {
		command: "npm start",
		env: {
			MULTICA_BIN: fileURLToPath(new URL("./apps/bridge/test/fixtures/fake-multica.sh", import.meta.url)),
		},
		url: "http://127.0.0.1:4317/healthz",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
