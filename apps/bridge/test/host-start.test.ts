import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertHostContext } from "../../../scripts/host-context.mjs";
import { copyRelease, isRecordedLauncher, releaseFiles } from "../../../scripts/host-start.mjs";

const temporary: string[] = [];
async function temporaryDirectory() {
	const path = await mkdtemp(join(tmpdir(), "office-host-test-"));
	temporary.push(path);
	return path;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("operator-owned Office installation", () => {
	it("refuses task context before creating an installation", async () => {
		const target = join(await temporaryDirectory(), "install");
		const result = spawnSync(process.execPath, [resolve("scripts/host-start.mjs"), target], {
			env: { MULTICA_TASK_ID: "synthetic-task" }, encoding: "utf8", timeout: 5_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("task-scoped authentication ends");
		expect(existsSync(target)).toBe(false);
	});

	it("rejects ancestor workdir markers and symlinks without modifying them", async () => {
		const root = await temporaryDirectory();
		await mkdir(join(root, ".multica"));
		const marker = join(root, ".multica/daemon_task_context.json");
		await writeFile(marker, "synthetic task marker");
		await mkdir(join(root, "child"));
		const link = join(await temporaryDirectory(), "linked");
		await symlink(join(root, "child"), link);
		expect(() => assertHostContext({}, join(root, "child/new-install"))).toThrow("task-managed");
		expect(() => assertHostContext({}, link)).toThrow("task-managed");
		expect(await readFile(marker, "utf8")).toBe("synthetic task marker");
	});

	it("allows an ordinary directory but rejects the daemon signal", async () => {
		const root = await temporaryDirectory();
		expect(() => assertHostContext({}, root)).not.toThrow();
		expect(() => assertHostContext({ MULTICA_DAEMON_PORT: "12345" }, root)).toThrow("task-scoped");
	});

	it("copies only release files and never overwrites an existing target", async () => {
		const root = await temporaryDirectory();
		const source = join(root, "source");
		const target = join(root, "release");
		for (const file of releaseFiles) {
			await mkdir(dirname(join(source, file)), { recursive: true });
			await writeFile(join(source, file), `release fixture: ${file}`);
		}
		await mkdir(join(source, ".multica"));
		await writeFile(join(source, ".multica/daemon_task_context.json"), "synthetic task");
		await writeFile(join(source, ".env"), "SYNTHETIC_SECRET=must-not-copy");
		await copyRelease(source, target);
		for (const file of releaseFiles) expect(await readFile(join(target, file), "utf8")).toBe(`release fixture: ${file}`);
		expect(existsSync(join(target, ".multica"))).toBe(false);
		expect(existsSync(join(target, ".env"))).toBe(false);
		await expect(copyRelease(source, target)).rejects.toThrow();
	});

	it("requires the exact Node launcher command and working directory before replacement", () => {
		const command = "/bin/node scripts/tailnet.mjs start";
		expect(isRecordedLauncher(command, "p123\nn/office\n", "/bin/node", "/office")).toBe(true);
		expect(isRecordedLauncher("/bin/multica daemon start", "n/office", "/bin/node", "/office")).toBe(false);
		expect(isRecordedLauncher(command, "n/another-office", "/bin/node", "/office")).toBe(false);
		expect(isRecordedLauncher("/bin/node unrelated.mjs", "n/office", "/bin/node", "/office")).toBe(false);
	});
});
