# Gondolin with Network Access and Extra Mounts

A pi extension that routes the built-in tools (`read`, `write`, `edit`, `bash`, `ls`, `find`, `grep`) and `!` commands into a Gondolin micro-VM. On top of the upstream example it adds a per-project configuration for network access and for mounting additional host directories.

Based on the pi 0.99.1 example: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/gondolin>. `index.ts` is that example plus a few hooks; everything specific to this extension lives in `config.ts`.

## Installation

```bash
cd /path/to/this/directory
npm install --ignore-scripts
```

Then start pi from the project you want mounted:

```bash
cd /path/to/your/project
pi -e /path/to/this/directory
```

To load it for every session, put the directory under `~/.pi/agent/extensions/`.

## Configuration

The extension reads `gondolin.json` in pi's agent directory: `~/.pi/agent/gondolin.json`, or `$PI_CODING_AGENT_DIR/gondolin.json` if that variable is set. The file applies to every project. It is outside the workspace, so commands in the VM cannot change it. Without the file the VM has full network access and no extra mounts.

```json
{
  "network": {
    "mode": "full",
    "filter": {
      "allow": ["api.github.com", "*.npmjs.org"],
      "deny": ["telemetry.example.com"]
    },
    "allowInternal": []
  },
  "mounts": [
    { "host": "~/.pi/agent", "guest": "/workspace/.pi-agent", "hide": ["auth.json", "sessions"] },
    { "host": "~/.local/share/pi", "guest": "/workspace/.pi-install" }
  ]
}
```

The file is read each time the VM starts. If it cannot be parsed or contains an unknown key or an invalid value, the VM does not start and every tool call and `!` command fails with the config error; nothing falls back to the host or to default settings.

`/gondolin` shows the VM, the active network policy and the mounts.

### Network

| Key | Meaning |
|-----|---------|
| `mode` | `"full"` (default) or `"none"`. `"none"` boots the VM without a network device. |
| `filter.allow` | Host patterns that may be reached. Omitted: every host. Empty list: no host. |
| `filter.deny` | Host patterns that are always blocked, also when they match `allow`. |
| `allowInternal` | Host patterns that may resolve to private or loopback addresses. Those are blocked otherwise. |

Patterns use `*` as a wildcard, for example `*.github.com`. `*.github.com` does not match `github.com` itself.

"Full" means HTTP and HTTPS through Gondolin's intercepting proxy. Other TCP protocols are not forwarded.

### Mounts

| Key | Meaning |
|-----|---------|
| `host` | Host directory, as an absolute path or starting with `~/`. Must exist. |
| `guest` | Path in the VM. Default: `/workspace/<name of the host directory>`. |
| `mode` | `"ro"` (default): the VM can only read the directory. `"rw"`: the VM can also write to this host directory. |
| `hide` | Paths inside the mount that do not exist for the VM. They cannot be read, listed or overwritten. |

The tools accept both forms of a path: `/workspace/.pi-agent/settings.json` and `/home/you/.pi/agent/settings.json` refer to the same file. Host paths of mounted directories in pi's system prompt (its documentation, skills, and so on) are rewritten to their guest paths, and the mounts are listed for the model.

A mount under `/workspace` appears inside the project tree in the VM only; nothing is created in the host project. If the project already has an entry with that name, the mount covers it and the extension prints a warning.

Symbolic links that point outside a mounted directory cannot be followed in the VM. To make such a link work, mount its target directory at the same path, for example `{ "host": "/opt/agenting", "guest": "/opt/agenting" }`.

### Letting pi inspect itself

The example above mounts pi's own files read-only:

- `/workspace/.pi-agent` (`~/.pi/agent`) holds `settings.json`, the installed extensions, the skills and this extension's `gondolin.json`.
- `/workspace/.pi-install` (`~/.local/share/pi`) holds pi's documentation and example extensions.

The agent can read how pi is set up and propose changes, in the conversation or as files in the project. You apply them on the host; they take effect after `/reload` or a restart.

To let the agent write to one of these directories itself, add `"mode": "rw"` to that mount. Read the security notes below before doing that for `~/.pi/agent`.

## What Runs Where

In the VM:

- File tools (`read`, `write`, `edit`, `ls`, `find`, `grep`)
- Shell commands (`bash` and `!` commands)

On the host:

- pi itself and all extensions
- Model API calls
- Tools registered by other extensions

## Requirements

- Node.js >= 23.6.0
- QEMU (for example `sudo apt install qemu-system-x86` or `brew install qemu`)

## Troubleshooting

- **HTTPS requests from the VM time out, plain HTTP works**: pi is running from the standalone binary. That binary embeds the Bun runtime, and Gondolin 0.12.0's TLS interception only works on Node.js. Run pi from the npm package instead (`npm install -g @earendil-works/pi-coding-agent`). This also affects the unmodified upstream example.
- **A request returns 403**: the host is not in `filter.allow`, matches `filter.deny`, or resolves to an internal address that is not in `allowInternal`.
- **"Gondolin VM not started"**: the message names the problem in `gondolin.json`. Fix the file and run the command again.
- **"QEMU not found"**: install QEMU through your package manager.
- **VM does not boot**: check KVM access (`sudo usermod -aG kvm $USER`, then log in again).

## Security Notes

- The configuration file is in pi's agent directory, not in the workspace, so the VM cannot change its own network policy or mounts. This holds as long as that directory is not mounted read-write.
- A read-only mount still discloses everything in it that is not listed in `hide`. `~/.pi/agent/auth.json` holds provider credentials and `sessions/` holds earlier conversations; keep both in `hide` when mounting that directory.
- Commands in the VM inherit pi's environment variables, including API keys set that way. With network access they can be sent out.

### `"mode": "rw"` on `~/.pi/agent`

pi loads and executes files from `~/.pi/agent` on the host, in every project and without a trust prompt. If the VM can write there, a file written inside the VM runs outside it at the next `/reload` or pi start, with your user's permissions. The agent does not have to intend this; instructions in a web page, a package README or a repository file it reads can steer it.

The paths that matter:

| Path | What a write does |
|------|-------------------|
| `extensions/` | A new or changed file is loaded as an extension on the host. |
| `npm/`, `git/` | Installed packages, including other extensions, can be altered or disabled. |
| `settings.json` | `extensions` and `packages` can point at new code; `npmCommand` and `externalEditor` are commands run on the host; `httpProxy` reroutes model traffic; `defaultProjectTrust` can switch off trust prompts. |
| `models.json` | A provider `baseUrl` can be redirected; an `apiKey` starting with `!` is a command run on the host. |
| `auth.json` | A `key` starting with `!` is a command run on the host. A hidden path cannot be written either. |
| `skills/` | Instructions that persist into every later session, including sessions without the VM. |
| `gondolin.json` | The VM can change its own network policy and mounts for the next start. |

If this extension is installed under `~/.pi/agent/extensions/`, it is writable as well.

With such a mount the VM no longer protects the host from the agent.

## Development

```bash
npm test
```

runs the unit tests for `config.ts`. To update to a newer upstream example, diff `index.ts` against the example shipped with pi (`examples/extensions/gondolin/index.ts`) and re-apply the hooks: the `config.ts` import, `pathRoots` in `toGuestPath`, `createVm`/`startVm`, the `/gondolin` output and the `before_agent_start` handler.
