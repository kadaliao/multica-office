import { describe, expect, it } from "vitest";
import {
	normalizeTailnetOrigin,
	readAccessConfiguration,
} from "../src/access.js";

describe("access configuration", () => {
	it("keeps loopback mode as the default", () => {
		expect(readAccessConfiguration({})).toEqual({ mode: "loopback" });
	});

	it("requires an explicitly enabled exact Tailscale HTTPS origin", () => {
		expect(() =>
			readAccessConfiguration({
				OFFICE_TAILNET_ORIGIN: "https://office.example.ts.net:8443",
			}),
		).toThrow(/requires OFFICE_ACCESS_MODE=tailnet/);
		expect(() =>
			readAccessConfiguration({ OFFICE_ACCESS_MODE: "tailnet" }),
		).toThrow(/is required/);
		expect(
			readAccessConfiguration({
				OFFICE_ACCESS_MODE: "tailnet",
				OFFICE_TAILNET_ORIGIN: "https://office.tail1234.ts.net:8443",
			}),
		).toEqual({
			mode: "tailnet",
			tailnetOrigin: "https://office.tail1234.ts.net:8443",
		});
	});

	it.each([
		"http://office.tail1234.ts.net:8443",
		"https://example.com",
		"https://office.tail1234.ts.net:8443/office",
		"https://office.tail1234.ts.net:8443/",
		"https://user@office.tail1234.ts.net:8443",
		"https://OFFICE.tail1234.ts.net:8443",
	])("rejects a non-canonical Tailnet origin: %s", (origin) => {
		expect(() => normalizeTailnetOrigin(origin)).toThrow(/exact HTTPS/);
	});

	it("does not combine development CORS with tailnet access", () => {
		expect(() =>
			readAccessConfiguration({
				OFFICE_ACCESS_MODE: "tailnet",
				OFFICE_TAILNET_ORIGIN: "https://office.tail1234.ts.net:8443",
				OFFICE_DEV_ORIGIN: "http://127.0.0.1:5173",
			}),
		).toThrow(/not allowed/);
	});
});
