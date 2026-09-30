import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
	createPathRoots,
	describeMount,
	describeNetwork,
	findShadowedWorkspaceEntries,
	loadConfig,
	mapHostPathToGuest,
	matchHost,
	parseConfig,
	type ResolvedMount,
	resolveMounts,
	rewriteHostPaths,
	toVmNetworkOptions,
} from "./config.ts";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-config-")));
	tempDirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(agentDir: string, content: string): void {
	fs.writeFileSync(path.join(agentDir, "gondolin.json"), content);
}

function mount(host: string, guest: string, extra: Partial<ResolvedMount> = {}): ResolvedMount {
	return { host, realHost: host, guest, mode: "ro", hide: [], ...extra };
}

test("loadConfig returns defaults when the file is missing", () => {
	assert.deepEqual(loadConfig(tempDir()), { network: { mode: "full" }, mounts: [] });
});

test("loadConfig reads network and mounts", () => {
	const agentDir = tempDir();
	writeConfig(
		agentDir,
		JSON.stringify({
			network: { mode: "none" },
			mounts: [{ host: "~/x", guest: "/mnt/x", mode: "rw", hide: ["secret"] }],
		}),
	);
	assert.deepEqual(loadConfig(agentDir), {
		network: { mode: "none" },
		mounts: [{ host: "~/x", guest: "/mnt/x", mode: "rw", hide: ["secret"] }],
	});
});

test("loadConfig throws on invalid JSON instead of falling back to defaults", () => {
	const agentDir = tempDir();
	writeConfig(agentDir, "{ not json");
	assert.throws(() => loadConfig(agentDir), /gondolin\.json/);
});

test("parseConfig rejects unknown keys and bad values", () => {
	assert.throws(() => parseConfig({ netwrok: {} }), /unknown key "netwrok"/);
	assert.throws(() => parseConfig({ network: { mode: "off" } }), /network\.mode/);
	assert.throws(() => parseConfig({ network: { filters: {} } }), /unknown key "filters"/);
	assert.throws(() => parseConfig({ network: { filter: { allow: "a.example" } } }), /network\.filter\.allow/);
	assert.throws(() => parseConfig({ mounts: [{ guest: "/mnt/x" }] }), /mounts\[0\]\.host/);
	assert.throws(() => parseConfig({ mounts: [{ host: "x", mode: "readonly" }] }), /mounts\[0\]\.mode/);
	assert.throws(() => parseConfig([]), /config must be an object/);
});

test("resolveMounts applies defaults and resolves host paths", () => {
	const dir = tempDir();
	fs.mkdirSync(path.join(dir, "shared"));
	fs.symlinkSync(path.join(dir, "shared"), path.join(dir, "link"));
	const home = os.homedir();
	const mounts = resolveMounts(
		parseConfig({
			mounts: [
				{ host: path.join(dir, "shared") },
				{ host: `${dir}/link/`, guest: "/mnt/link" },
				{ host: "~", guest: "/mnt/home/", mode: "rw", hide: ["./a/", "/b"] },
			],
		}),
	);
	assert.deepEqual(mounts, [
		{ host: path.join(dir, "shared"), realHost: path.join(dir, "shared"), guest: "/workspace/shared", mode: "ro", hide: [] },
		{ host: path.join(dir, "link"), realHost: path.join(dir, "shared"), guest: "/mnt/link", mode: "ro", hide: [] },
		{ host: home, realHost: fs.realpathSync(home), guest: "/mnt/home", mode: "rw", hide: ["a", "b"] },
	]);
});

test("resolveMounts rejects unusable mounts", () => {
	const dir = tempDir();
	const a = path.join(dir, "a");
	const b = path.join(dir, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	fs.writeFileSync(path.join(dir, "file"), "");
	const resolve = (mounts: unknown) => resolveMounts(parseConfig({ mounts }));
	assert.throws(() => resolve([{ host: "relative/dir" }]), /must be absolute or start with ~/);
	assert.throws(() => resolve([{ host: "~other/dir" }]), /must be absolute or start with ~/);
	assert.throws(() => resolve([{ host: path.join(dir, "missing") }]), /does not exist/);
	assert.throws(() => resolve([{ host: path.join(dir, "file") }]), /not a directory/);
	assert.throws(() => resolve([{ host: a, guest: "relative" }]), /absolute path/);
	assert.throws(() => resolve([{ host: a, guest: "/" }]), /must not be \//);
	assert.throws(() => resolve([{ host: a, guest: "/workspace/" }]), /must not be \/workspace/);
	assert.throws(() => resolve([{ host: a, guest: "/mnt/x" }, { host: b, guest: "/mnt/x" }]), /already used/);
	assert.throws(() => resolve([{ host: a, hide: ["../outside"] }]), /inside the mount/);
});

test("findShadowedWorkspaceEntries reports mounts covering existing entries", () => {
	const cwd = tempDir();
	fs.mkdirSync(path.join(cwd, "docs"));
	const mounts = [mount("/h/docs", "/workspace/docs"), mount("/h/new", "/workspace/new"), mount("/h/etc", "/mnt/docs")];
	assert.deepEqual(findShadowedWorkspaceEntries(cwd, mounts), ["/workspace/docs"]);
});

test("matchHost uses gondolin's wildcard syntax", () => {
	assert.equal(matchHost("api.github.com", "api.github.com"), true);
	assert.equal(matchHost("API.GitHub.com", "api.github.com"), true);
	assert.equal(matchHost("api.github.com", "*.github.com"), true);
	assert.equal(matchHost("github.com", "*.github.com"), false);
	assert.equal(matchHost("apixgithub.com", "api.github.com"), false);
	assert.equal(matchHost("anything.example", "*"), true);
	assert.equal(matchHost("anything.example", ""), false);
});

test("toVmNetworkOptions disables the network for mode none", () => {
	assert.deepEqual(toVmNetworkOptions({ mode: "none" }), { sandbox: { netEnabled: false } });
});

test("toVmNetworkOptions enforces allow, deny and internal ranges", async () => {
	const allowed = async (network: Parameters<typeof toVmNetworkOptions>[0], hostname: string, ip = "93.184.216.34") => {
		const { httpHooks, sandbox } = toVmNetworkOptions(network);
		assert.equal(sandbox, undefined);
		return httpHooks?.isIpAllowed?.({ hostname, ip, family: 4, port: 443, protocol: "https" });
	};

	assert.equal(await allowed({ mode: "full" }, "example.com"), true);
	assert.equal(await allowed({ mode: "full" }, "intranet.example", "10.0.0.5"), false);
	assert.equal(await allowed({ mode: "full", allowInternal: ["intranet.example"] }, "intranet.example", "10.0.0.5"), true);

	const allowOnly = { mode: "full", filter: { allow: ["*.github.com"] } } as const;
	assert.equal(await allowed(allowOnly, "api.github.com"), true);
	assert.equal(await allowed(allowOnly, "example.com"), false);
	assert.equal(await allowed({ mode: "full", filter: { allow: [] } }, "example.com"), false);

	const denyWins = { mode: "full", filter: { allow: ["*.example.com"], deny: ["bad.example.com"] } } as const;
	assert.equal(await allowed(denyWins, "good.example.com"), true);
	assert.equal(await allowed(denyWins, "bad.example.com"), false);
	assert.equal(await allowed({ mode: "full", filter: { deny: ["*.tracker.example"] } }, "a.tracker.example"), false);
	assert.equal(await allowed({ mode: "full", filter: { deny: ["*.tracker.example"] } }, "example.com"), true);
});

test("mapHostPathToGuest picks the longest matching root", () => {
	const roots = createPathRoots("/home/u/proj", [
		mount("/home/u/.pi/agent", "/workspace/.pi-agent"),
		mount("/home/u", "/mnt/home"),
		{ ...mount("/link/lib", "/workspace/lib"), realHost: "/real/lib" },
	]);
	assert.equal(mapHostPathToGuest(roots, "/home/u/proj"), "/workspace");
	assert.equal(mapHostPathToGuest(roots, "/home/u/proj/src/a.ts"), "/workspace/src/a.ts");
	assert.equal(mapHostPathToGuest(roots, "/home/u/.pi/agent/settings.json"), "/workspace/.pi-agent/settings.json");
	assert.equal(mapHostPathToGuest(roots, "/home/u/other"), "/mnt/home/other");
	assert.equal(mapHostPathToGuest(roots, "/link/lib/x"), "/workspace/lib/x");
	assert.equal(mapHostPathToGuest(roots, "/real/lib/x"), "/workspace/lib/x");
	assert.equal(mapHostPathToGuest(roots, "/home/u/.pi/agent-other/x"), "/mnt/home/.pi/agent-other/x");
	assert.equal(mapHostPathToGuest(roots, "/etc/passwd"), undefined);
	assert.equal(mapHostPathToGuest(roots, "/workspace/src/a.ts"), undefined);
});

test("rewriteHostPaths replaces whole mounted paths only", () => {
	const mounts = [mount("/home/u/.pi/agent", "/workspace/.pi-agent"), mount("/opt/pi", "/workspace/.pi-install")];
	const rewrite = (text: string) => rewriteHostPaths(text, mounts, "/home/u/proj");
	assert.equal(rewrite("- Docs: /opt/pi/docs\n- Examples: /opt/pi/examples (extensions)"), "- Docs: /workspace/.pi-install/docs\n- Examples: /workspace/.pi-install/examples (extensions)");
	assert.equal(rewrite("see /home/u/.pi/agent."), "see /workspace/.pi-agent.");
	assert.equal(rewrite("`/home/u/.pi/agent/skills/x/SKILL.md`"), "`/workspace/.pi-agent/skills/x/SKILL.md`");
	assert.equal(rewrite("/home/u/.pi/agent-backup/x"), "/home/u/.pi/agent-backup/x");
	assert.equal(rewrite("/home/u/.pi/agent.bak"), "/home/u/.pi/agent.bak");
	assert.equal(rewrite("/mnt/opt/pi/docs"), "/mnt/opt/pi/docs");
	assert.equal(rewrite("Current working directory: /home/u/proj"), "Current working directory: /home/u/proj");
});

test("rewriteHostPaths leaves mounts that contain the workspace alone", () => {
	const mounts = [mount("/home/u", "/mnt/home")];
	assert.equal(rewriteHostPaths("cwd: /home/u/proj, other: /home/u/x", mounts, "/home/u/proj"), "cwd: /home/u/proj, other: /home/u/x");
});

test("describe helpers summarize the active policy", () => {
	assert.equal(describeNetwork({ mode: "none" }), "none");
	assert.equal(describeNetwork({ mode: "full" }), "full");
	assert.equal(
		describeNetwork({ mode: "full", filter: { allow: ["a.example"], deny: ["b.example"] }, allowInternal: ["c.example"] }),
		"full (allow: a.example; deny: b.example; internal: c.example)",
	);
	assert.equal(describeNetwork({ mode: "full", filter: { allow: [] } }), "full (allow: nothing)");
	assert.equal(
		describeMount(mount("/home/u/.pi/agent", "/workspace/.pi-agent", { mode: "rw", hide: ["auth.json"] })),
		"/workspace/.pi-agent (read-write; host: /home/u/.pi/agent; hidden: auth.json)",
	);
});
