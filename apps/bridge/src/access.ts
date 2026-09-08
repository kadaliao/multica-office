export type AccessMode = "loopback" | "tailnet";

export interface AccessConfiguration {
	mode: AccessMode;
	tailnetOrigin?: string;
}

const TAILNET_HOSTNAME =
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

export function normalizeTailnetOrigin(input: string): string {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error("OFFICE_TAILNET_ORIGIN must be an HTTPS origin");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.origin !== input ||
		!TAILNET_HOSTNAME.test(parsed.hostname)
	) {
		throw new Error(
			"OFFICE_TAILNET_ORIGIN must be an exact HTTPS *.ts.net origin without a path",
		);
	}
	return parsed.origin;
}

export function readAccessConfiguration(
	environment: NodeJS.ProcessEnv,
): AccessConfiguration {
	const mode = environment.OFFICE_ACCESS_MODE ?? "loopback";
	if (mode !== "loopback" && mode !== "tailnet") {
		throw new Error("OFFICE_ACCESS_MODE must be loopback or tailnet");
	}
	const configuredOrigin = environment.OFFICE_TAILNET_ORIGIN;
	if (mode === "loopback") {
		if (configuredOrigin) {
			throw new Error(
				"OFFICE_TAILNET_ORIGIN requires OFFICE_ACCESS_MODE=tailnet",
			);
		}
		return { mode };
	}
	if (!configuredOrigin) {
		throw new Error(
			"OFFICE_TAILNET_ORIGIN is required when OFFICE_ACCESS_MODE=tailnet",
		);
	}
	if (environment.OFFICE_DEV_ORIGIN) {
		throw new Error("OFFICE_DEV_ORIGIN is not allowed in tailnet mode");
	}
	return { mode, tailnetOrigin: normalizeTailnetOrigin(configuredOrigin) };
}
