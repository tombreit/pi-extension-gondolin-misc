/**
 * User-level configuration for the Gondolin extension: network policy and
 * additional host mounts, read from gondolin.json in pi's agent directory
 * (~/.pi/agent by default). The file is outside the workspace on purpose, so
 * the VM cannot change its own policy.
 *
 * This file has no pi imports so index.ts stays close to the upstream example
 * and the logic here can be tested with plain `node --test`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createHttpHooks,
	createShadowPathPredicate,
	ReadonlyProvider,
	RealFSProvider,
	ShadowProvider,
	type VirtualProvider,
	type VMOptions,
} from "@earendil-works/gondolin";

export const GUEST_WORKSPACE = "/workspace";
export const CONFIG_FILE_NAME = "gondolin.json";

export type NetworkConfig = {
	mode: "full" | "none";
	filter?: {
		/** host patterns that may be reached (omitted = all, empty = none) */
		allow?: string[];
		/** host patterns that are always blocked, even when allowed above */
		deny?: string[];
	};
	/** host patterns allowed to resolve to internal ip ranges */
	allowInternal?: string[];
};

export type MountConfig = {
	host: string;
	guest?: string;
	mode?: "ro" | "rw";
	hide?: string[];
};

export type GondolinConfig = {
	network: NetworkConfig;
	mounts: MountConfig[];
};

export type ResolvedMount = {
	/** absolute host directory as configured */
	host: string;
	/** host directory with symlinks resolved */
	realHost: string;
	guest: string;
	mode: "ro" | "rw";
	/** paths relative to the mount root that do not exist for the guest */
	hide: string[];
};

export type PathRoot = { host: string; guest: string };

const DEFAULT_CONFIG: GondolinConfig = { network: { mode: "full" }, mounts: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${field} must be an object`);
	return value;
}

// Unknown keys are rejected so a typo cannot silently drop a restriction.
function expectKeys(value: Record<string, unknown>, field: string, allowed: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${field} has unknown key "${key}"`);
	}
}

function expectStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${field} must be an array of non-empty strings`);
	}
	return value as string[];
}

function parseNetwork(value: unknown): NetworkConfig {
	if (value === undefined) return { ...DEFAULT_CONFIG.network };
	const network = expectRecord(value, "network");
	expectKeys(network, "network", ["mode", "filter", "allowInternal"]);
	const mode: unknown = network.mode ?? "full";
	if (mode !== "full" && mode !== "none") throw new Error(`network.mode must be "full" or "none"`);
	const result: NetworkConfig = { mode };
	if (network.filter !== undefined) {
		const filter = expectRecord(network.filter, "network.filter");
		expectKeys(filter, "network.filter", ["allow", "deny"]);
		result.filter = {};
		if (filter.allow !== undefined) result.filter.allow = expectStringArray(filter.allow, "network.filter.allow");
		if (filter.deny !== undefined) result.filter.deny = expectStringArray(filter.deny, "network.filter.deny");
	}
	if (network.allowInternal !== undefined) {
		result.allowInternal = expectStringArray(network.allowInternal, "network.allowInternal");
	}
	return result;
}

function parseMounts(value: unknown): MountConfig[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("mounts must be an array");
	return value.map((entry, index) => {
		const field = `mounts[${index}]`;
		const mount = expectRecord(entry, field);
		expectKeys(mount, field, ["host", "guest", "mode", "hide"]);
		if (typeof mount.host !== "string" || mount.host.trim() === "") {
			throw new Error(`${field}.host must be a non-empty string`);
		}
		const result: MountConfig = { host: mount.host };
		if (mount.guest !== undefined) {
			if (typeof mount.guest !== "string") throw new Error(`${field}.guest must be a string`);
			result.guest = mount.guest;
		}
		if (mount.mode !== undefined) {
			if (mount.mode !== "ro" && mount.mode !== "rw") throw new Error(`${field}.mode must be "ro" or "rw"`);
			result.mode = mount.mode;
		}
		if (mount.hide !== undefined) result.hide = expectStringArray(mount.hide, `${field}.hide`);
		return result;
	});
}

export function parseConfig(value: unknown): GondolinConfig {
	const config = expectRecord(value, "config");
	expectKeys(config, "config", ["network", "mounts"]);
	return { network: parseNetwork(config.network), mounts: parseMounts(config.mounts) };
}

/**
 * Load <agentDir>/gondolin.json. A missing file yields the defaults; a file that
 * cannot be read or does not validate throws, so the VM never starts with a
 * policy the user did not write.
 */
export function loadConfig(agentDir: string): GondolinConfig {
	const configPath = path.join(agentDir, CONFIG_FILE_NAME);
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { network: { ...DEFAULT_CONFIG.network }, mounts: [] };
		}
		throw new Error(`${configPath}: ${(error as Error).message}`);
	}
	try {
		return parseConfig(JSON.parse(raw));
	} catch (error) {
		throw new Error(`${configPath}: ${(error as Error).message}`);
	}
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInsidePath(root: string, value: string, pathApi: path.PlatformPath = path): boolean {
	const relativePath = pathApi.relative(root, value);
	return relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
}

function normalizeGuestPath(guest: string, field: string): string {
	if (!guest.startsWith("/")) throw new Error(`${field}.guest must be an absolute path: ${guest}`);
	const normalized = path.posix.resolve("/", guest);
	if (normalized === "/" || normalized === GUEST_WORKSPACE) {
		throw new Error(`${field}.guest must not be ${normalized}`);
	}
	return normalized;
}

function normalizeHidePath(hidden: string, field: string): string {
	const normalized = path.posix.normalize(toPosix(hidden)).replace(/^\/+|\/+$/g, "");
	if (normalized === "" || normalized === "." || normalized.split("/").includes("..")) {
		throw new Error(`${field}.hide entries must be paths inside the mount: ${hidden}`);
	}
	return normalized;
}

/** Resolve and validate the configured mounts against the host filesystem. */
export function resolveMounts(config: GondolinConfig): ResolvedMount[] {
	const mounts: ResolvedMount[] = [];
	for (const [index, entry] of config.mounts.entries()) {
		const field = `mounts[${index}]`;
		// The config applies to every project, so a path relative to the working directory has no fixed meaning.
		const expanded = expandHome(entry.host);
		if (!path.isAbsolute(expanded)) throw new Error(`${field}.host must be absolute or start with ~/: ${entry.host}`);
		const host = path.resolve(expanded);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(host);
		} catch {
			throw new Error(`${field}.host does not exist: ${host}`);
		}
		if (!stat.isDirectory()) throw new Error(`${field}.host is not a directory: ${host}`);

		const guest = normalizeGuestPath(entry.guest ?? path.posix.join(GUEST_WORKSPACE, path.basename(host)), field);
		if (mounts.some((mount) => mount.guest === guest)) {
			throw new Error(`${field}.guest is already used by another mount: ${guest}`);
		}

		mounts.push({
			host,
			realHost: fs.realpathSync(host),
			guest,
			mode: entry.mode ?? "ro",
			hide: (entry.hide ?? []).map((hidden) => normalizeHidePath(hidden, field)),
		});
	}
	return mounts;
}

export function createMountProvider(mount: ResolvedMount): VirtualProvider {
	let provider: VirtualProvider = new RealFSProvider(mount.host);
	if (mount.hide.length > 0) {
		provider = new ShadowProvider(provider, {
			shouldShadow: createShadowPathPredicate(mount.hide.map((hidden) => `/${hidden}`)),
		});
	}
	if (mount.mode === "ro") provider = new ReadonlyProvider(provider);
	return provider;
}

/** Guest paths under /workspace that cover an entry that exists in the host workspace. */
export function findShadowedWorkspaceEntries(localCwd: string, mounts: ResolvedMount[]): string[] {
	return mounts
		.filter((mount) => isInsidePath(GUEST_WORKSPACE, mount.guest, path.posix))
		.filter((mount) => fs.existsSync(path.join(localCwd, path.posix.relative(GUEST_WORKSPACE, mount.guest))))
		.map((mount) => mount.guest);
}

// Same pattern syntax as gondolin's allowedHosts: "*" matches any substring.
export function matchHost(hostname: string, pattern: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (!normalizedPattern) return false;
	if (normalizedPattern === "*") return true;
	const escaped = normalizedPattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i").test(hostname);
}

/** Translate the network config into the gondolin options that enforce it. */
export function toVmNetworkOptions(network: NetworkConfig): Pick<VMOptions, "httpHooks" | "sandbox"> {
	if (network.mode === "none") return { sandbox: { netEnabled: false } };
	const deny = network.filter?.deny ?? [];
	const { httpHooks } = createHttpHooks({
		allowedHosts: network.filter?.allow,
		allowedInternalHosts: network.allowInternal,
		isIpAllowed: deny.length > 0 ? (info) => !deny.some((pattern) => matchHost(info.hostname, pattern)) : undefined,
	});
	return { httpHooks };
}

/** Host roots that tool paths are translated from; the longest matching root wins. */
export function createPathRoots(localCwd: string, mounts: ResolvedMount[]): PathRoot[] {
	const roots: PathRoot[] = [{ host: localCwd, guest: GUEST_WORKSPACE }];
	for (const mount of mounts) {
		roots.push({ host: mount.host, guest: mount.guest });
		if (mount.realHost !== mount.host) roots.push({ host: mount.realHost, guest: mount.guest });
	}
	return roots;
}

export function mapHostPathToGuest(roots: PathRoot[], hostPath: string): string | undefined {
	let best: PathRoot | undefined;
	for (const root of roots) {
		if (!isInsidePath(root.host, hostPath)) continue;
		if (!best || root.host.length > best.host.length) best = root;
	}
	if (!best) return undefined;
	const relativePath = path.relative(best.host, hostPath);
	return relativePath ? path.posix.join(best.guest, toPosix(relativePath)) : best.guest;
}

/**
 * Replace host paths of mounted directories in free text with their guest
 * paths. Mounts that contain the host workspace are left alone: paths below
 * them are ambiguous with /workspace.
 */
export function rewriteHostPaths(text: string, mounts: ResolvedMount[], localCwd: string): string {
	const roots = createPathRoots(localCwd, mounts)
		.slice(1)
		.filter((root) => !isInsidePath(root.host, localCwd))
		.sort((a, b) => b.host.length - a.host.length);
	if (roots.length === 0) return text;
	const alternatives = roots.map((root) => root.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	// Only match whole paths: not inside a longer path, and not a prefix of a sibling name.
	const pattern = new RegExp(`(?<![\\w.~-])(?:${alternatives})(?![\\w-])(?!\\.[\\w-])`, "g");
	return text.replace(pattern, (match) => roots.find((root) => root.host === match)?.guest ?? match);
}

export function describeNetwork(network: NetworkConfig): string {
	if (network.mode === "none") return "none";
	const details: string[] = [];
	if (network.filter?.allow) details.push(`allow: ${network.filter.allow.join(", ") || "nothing"}`);
	if (network.filter?.deny?.length) details.push(`deny: ${network.filter.deny.join(", ")}`);
	if (network.allowInternal?.length) details.push(`internal: ${network.allowInternal.join(", ")}`);
	return details.length > 0 ? `full (${details.join("; ")})` : "full";
}

export function describeMount(mount: ResolvedMount): string {
	const mode = mount.mode === "ro" ? "read-only" : "read-write";
	const hidden = mount.hide.length > 0 ? `; hidden: ${mount.hide.join(", ")}` : "";
	return `${mount.guest} (${mode}; host: ${mount.host}${hidden})`;
}
