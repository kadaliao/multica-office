import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CliFailure, createCliRunner } from "../src/runner.js";

const fixture = (name: string): string =>
	resolve("apps/bridge/test/fixtures", name);

describe("controlled CLI runner", () => {
	it("uses only fixed command templates and parses JSON", async () => {
		const runner = createCliRunner({ executable: fixture("fake-multica.sh") });
		const agents = await runner.run({ key: "agents" });
		expect(agents).toHaveLength(1);
		await expect(
			runner.run({ key: "issues", offset: 100 }),
		).resolves.toMatchObject({ offset: 100 });
	});

	it("rejects invalid parameters before spawning", async () => {
		const runner = createCliRunner({ executable: fixture("fake-multica.sh") });
		await expect(
			runner.run({ key: "issues", offset: -1 }),
		).rejects.toMatchObject({
			detail: { code: "forbidden" },
		});
		await expect(
			runner.run({ key: "issueRuns", issueId: "x; touch /tmp/nope" }),
		).rejects.toBeInstanceOf(CliFailure);
	});

	it("classifies timeout and output limits", async () => {
		const slow = createCliRunner({
			executable: fixture("slow-multica.sh"),
			listTimeoutMs: 20,
		});
		await expect(slow.run({ key: "agents" })).rejects.toMatchObject({
			detail: { code: "timeout" },
		});

		const large = createCliRunner({
			executable: fixture("large-multica.sh"),
			maxBufferBytes: 64,
		});
		await expect(large.run({ key: "agents" })).rejects.toMatchObject({
			detail: { code: "output_too_large" },
		});
	});

	it("classifies CLI authentication failure without exposing stderr", async () => {
		const runner = createCliRunner({ executable: fixture("auth-multica.sh") });
		await expect(runner.run({ key: "agents" })).rejects.toMatchObject({
			detail: {
				code: "auth_required",
				message: "Multica CLI is not signed in.",
			},
		});
	});
});
