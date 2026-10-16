# Using Termilab from AI agents and scripts

Termilab lets an AI agent, a bot or a shell script work on the servers saved in Termilab **without ever handling a credential**. The caller names a host and an action; the Termilab instance running on your desktop connects with the password or key it already holds and returns the result. Passwords, private keys and passphrases never leave the Termilab process.

There are two ways in, and both reach the same place:

- **MCP** (`termilab-cli mcp`, also available as `termilab-mcp`): a stdio MCP server for Claude Code, Codex CLI, Gemini CLI, Cursor and any other MCP client.
- **Command line** (`termilab-cli hosts | run | read | write`): for scripts, cron jobs, CI steps and bots that do not speak MCP.

## How it works

```
  AI agent (MCP client)          script / bot / cron
          |                              |
          | stdio, JSON-RPC              | argv, stdin, stdout, exit code
          v                              v
   termilab-cli mcp                termilab-cli run ...
          \                              /
           \   local socket + token     /
            v                          v
     +------------------------------------------+
     |  Termilab, running on your desktop       |
     |  holds hosts, passwords, keys, known     |
     |  hosts; checks the host key; logs calls  |
     +------------------------------------------+
                        |
                        | SSH / SFTP (or a local shell for "local")
                        v
                 your servers
```

- `termilab-cli` is a thin client. It holds no state and reads no host data; it forwards each request to the running Termilab over a local socket (`<userData>/agent.sock`, mode 0600, in a 0700 folder; a per-user named pipe on Windows) and authenticates with a random token in `<userData>/agent-token` (mode 0600). Only your own user account can open either. Nothing listens on the network.
- Termilab resolves the host, checks its host key against the keys you have already trusted, logs in with the saved credentials, runs the action and returns the result. Each `run_command` runs in a fresh SSH session; interactive shells stay open until closed or idle for 15 minutes.
- **Connections.** While an agent works, Termilab logs in to each host once and runs every call (commands, file reads and writes, shells) as a new channel on that connection, like OpenSSH's ControlMaster: one login per host instead of one per call. It closes after 10 minutes without agent activity (an open shell counts as activity) and when Termilab quits. Editing the host in Termilab drops it, so the next call logs in with the new settings. Up to 8 calls run at once per host; more wait their turn, and a server with a lower `MaxSessions` is detected and respected. If the connection drops, calls that were running fail with a clear error and are not repeated; calls still waiting reconnect on their own.
- `<userData>` is `~/.config/termilab` on Linux, `~/Library/Application Support/termilab` on macOS and `%APPDATA%\termilab` on Windows.

## Requirements

1. **Termilab must be open.** The socket exists only while Termilab runs. Without it every call fails with `Termilab is not running. Open Termilab first, then try again.`
2. **Each host's key must be trusted once from Termilab.** Agents never accept host keys. A host Termilab has not connected to yet, a host whose key changed, or a host that offers a new key type, fails with a message asking you to connect to it once from Termilab and check the key there. Open the host in Termilab, confirm the fingerprint, and from then on agents can use it.
3. The host must have usable credentials on this computer. A password or key that was saved on another computer and cannot be decrypted here shows as `available: false` with a note explaining what to do.

If Termilab runs with a non-default `--user-data-dir`, set `TERMILAB_USER_DATA` to the same folder for `termilab-cli`.

## Entry points per platform

| Install | Command line | MCP server |
|---|---|---|
| `.deb`, `.pacman` | `termilab-cli ...` (installed in `/usr/bin`) | `termilab-cli mcp` (or `termilab-mcp`) |
| AppImage | `/path/to/Termilab.AppImage --cli ...` | `/path/to/Termilab.AppImage --cli mcp` |
| Windows | `"%LOCALAPPDATA%\Programs\Termilab\Termilab.exe" --cli ...` | `... Termilab.exe --cli mcp` |
| macOS | `/Applications/Termilab.app/Contents/MacOS/Termilab --cli ...` | `... Termilab --cli mcp` |
| Source checkout | `node electron/agent/cli.js ...` | `node electron/agent/cli.js mcp` |

`--cli` runs the command line in Node mode, without opening a window. The older `--mcp` flag still works and is equivalent to `--cli mcp`.

For the AppImage, rename the file to a name without a version (for example `Termilab.AppImage`) before registering it: the updater replaces a versioned file with one named after the new version, which breaks the registered path, while an unversioned file is updated in place. Windows and macOS paths above are the default install locations; adjust them if you installed elsewhere.

With the AppImage, an alias gives you the same short command the packages install: `alias termilab-cli='/path/to/Termilab.AppImage --cli'` (for MCP clients, which do not read shell aliases, use the full path).

## Registering the MCP server

The examples use the deb/pacman command `termilab-cli mcp`. On other installs replace `termilab-cli` with the binary path from the table above, followed by `--cli mcp`.

### Claude Code

```bash
claude mcp add --scope user termilab -- termilab-cli mcp
```

`--scope user` makes Termilab available in every project. AppImage example:

```bash
claude mcp add --scope user termilab -- /opt/apps/Termilab.AppImage --cli mcp
```

### Generic MCP client (JSON)

Most clients accept this block (the `mcpServers` format):

```json
{
  "mcpServers": {
    "termilab": {
      "command": "termilab-cli",
      "args": ["mcp"]
    }
  }
}
```

On macOS, for example, `"command"` is `"/Applications/Termilab.app/Contents/MacOS/Termilab"` and `"args"` is `["--cli", "mcp"]`. Add `"env": { "TERMILAB_USER_DATA": "/path" }` only if Termilab runs with a custom `--user-data-dir`.

### Gemini CLI

Add the JSON block above to `~/.gemini/settings.json` (all projects) or `.gemini/settings.json` (one project), or run:

```bash
gemini mcp add --scope user termilab termilab-cli mcp
```

### Cursor

Add the JSON block above to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project.

### Codex CLI

Codex uses TOML in `~/.codex/config.toml`:

```toml
[mcp_servers.termilab]
command = "termilab-cli"
args = ["mcp"]
```

or run:

```bash
codex mcp add termilab -- termilab-cli mcp
```

Codex limits how long a tool call may take (`tool_timeout_sec`). For commands that run longer than that, raise it in the same table.

These file names and formats were checked against each tool's documentation in October 2026 (Codex: learn.chatgpt.com/docs/extend/mcp; Gemini CLI: geminicli.com/docs/tools/mcp-server; Cursor: cursor.com/docs/context/mcp). They have not been tested end to end against those clients; only Claude Code and the raw MCP protocol are exercised by Termilab's own tests. Check the client's documentation if a key has moved.

### What the agent learns on its own

An agent connected to Termilab does not need to be told how to use it. The server describes itself:

- the MCP `initialize` (and `server/discover`) result carries `instructions` with the workflow and what each error means;
- every tool and every argument has a description with units, defaults, limits and an example;
- the full guide below is served as the resource `termilab://guide` (Markdown) and as the prompt `termilab_usage`;
- `termilab-cli guide` prints the same guide for agents that only have a shell.

## What an agent can do on a server

<!-- agent-guide:start (generated from electron/agent/guide.js; edit that file, then copy it here with headings two levels down) -->
### Using Termilab as an AI agent

Termilab is an SSH client running on the user's computer. Through it you can work on the user's saved servers without ever seeing a password or key: you name a host, Termilab logs in with the credentials it already holds, and you get the result. You do not need credentials and must not ask the user for them.

#### Hosts

- Start with `list_hosts` (CLI: `termilab-cli hosts --json`). Use a host's `name` or `id` from that list in every other call.
- `local` is always available: it is this computer, in the user's login shell.
- `available: false` means the host cannot be used right now; its `note` says why (for example a password saved on another computer). Tell the user what the note says.
- On each host you act as that host's saved user, with exactly that user's permissions, root or sudo included. Be as careful as the user would be.

#### One-off commands: run_command

Each call runs in a fresh session: nothing (current directory, variables, sudo session) carries over to the next call. Use `cwd` instead of `cd`.

    run_command {"host": "produccion", "command": "docker ps", "cwd": "/srv/app"}

Returns `exit_code`, `stdout`, `stderr`, `timed_out`, `truncated`, `duration_ms`. Default timeout 60 s (`timeout_s`, max 3600). Each stream is capped at 256 KB: filter remotely (`| tail -n 200`, `grep`) instead of printing everything. There is no terminal: a command that asks a question (sudo password, `[Y/n]`) hangs until the timeout. Use a non-interactive form (`apt-get -y`, `sudo -n`) or an interactive shell.

#### Interactive and multi-step work: open_shell

For anything that needs state or answers prompts (navigating with `cd`, environment variables, `sudo` asking for a password, `[Y/n]` questions, deploy scripts, REPLs):

1. `open_shell {"host": "produccion"}` returns `session_id`.
2. `read_output {"session_id": "...", "wait_ms": 2000}` to see the login banner and prompt.
3. `send_input {"session_id": "...", "data": "cd /srv/app && ./deploy.sh\n"}`: end each command with `\n` (Enter).
4. `read_output` again, repeatedly, until the output stops growing and the shell prompt (or a question) is back. Output is raw terminal text and may contain escape codes.
5. Answer prompts with `send_input` (`"y\n"`). `"\u0003"` is Ctrl-C.
6. `close_shell {"session_id": "..."}` when done. Idle shells close after 15 minutes; `closed: true` and `exit_code` in `read_output` mean the shell has exited.

When sudo asks for a password you do not have it: stop and tell the user (they can run that step themselves in Termilab, or allow it without a password). Never guess or invent one.

#### Files: read_file and write_file

Over SFTP (or the local disk for `local`). Paths are absolute or relative to the home directory (`~` allowed).

    read_file  {"host": "produccion", "path": "/etc/nginx/nginx.conf"}
    write_file {"host": "produccion", "path": "~/app/.env", "content": "PORT=8080\n", "mode": "600"}

Text comes back as utf-8, other files as base64 (see `encoding`). Reads default to 256 KB (`max_bytes` up to 4 MB, `truncated: true` if cut); writes up to 4 MB and replace the whole file. To change a config: read it, edit, write it back, then verify (for example `nginx -t`).

#### Errors and what to do

- "Termilab is not running": ask the user to open Termilab, then retry.
- Host key not trusted yet, or CHANGED: ask the user to connect to that host once from Termilab and check the key there. Agents can never accept host keys. A changed key can mean an attack: do not work around it.
- "No host named ...": call `list_hosts` and use an exact name or id.
- "matches N hosts": use the `id` instead of the name.
- Authentication failed: the credentials saved in Termilab are wrong; ask the user to fix the host in Termilab.
- "Connection to ... was lost while ...": the network or the server dropped mid-call and it was NOT retried. The command may or may not have run: check its effect before running it again.

Every call is recorded in Termilab's Logs (tool, host, command, exit code, duration; never the output or file contents).

#### Command line (no MCP)

The same actions from a shell: `termilab-cli hosts`, `termilab-cli run [--cwd DIR] [--timeout S] <host> <command...>` (exits with the command's exit code, 124 on timeout, 125 if it could not run), `termilab-cli read <host> <path>`, `termilab-cli write [--mode 644] <host> <path> < file`. Add `--json` for the full result.
<!-- agent-guide:end -->

### Worked example: a deploy through an interactive shell

A typical sequence for work that needs a persistent session (here, a deploy script that asks for confirmation):

1. `list_hosts {}` and pick `produccion`.
2. `open_shell {"host": "produccion"}` returns `{"session_id": "sh_9c1e..."}`.
3. `read_output {"session_id": "sh_9c1e...", "wait_ms": 2000}` shows the banner and the prompt.
4. `send_input {"session_id": "sh_9c1e...", "data": "cd /srv/app && export RELEASE=2026.10\n"}`
5. `send_input {"session_id": "sh_9c1e...", "data": "./deploy.sh\n"}`
6. `read_output {"session_id": "sh_9c1e...", "wait_ms": 5000}`, repeated until the script stops at `Continue? [Y/n]`.
7. `send_input {"session_id": "sh_9c1e...", "data": "y\n"}`, then `read_output` until the shell prompt returns.
8. `close_shell {"session_id": "sh_9c1e..."}`.

The directory change and the `RELEASE` variable from step 4 are still in effect in step 5, which would not be the case with two `run_command` calls. With `run_command` the same deploy would be `{"host": "produccion", "command": "RELEASE=2026.10 ./deploy.sh --yes", "cwd": "/srv/app"}`, provided the script has a non-interactive mode.

### Permissions

On every host the agent has exactly the permissions of that host's saved user: if the user is root, or can use sudo, so can the agent. It never sees the password or the key. The host `local` is this computer, running as you, in your login shell; the same rules apply, including that it can only be used while Termilab is open.

## Command line reference

```
termilab-cli hosts [--json]
termilab-cli run [--timeout S] [--cwd DIR] [--json] <host> <command...>
termilab-cli read [--max-bytes N] [--json] <host> <path>
termilab-cli write [--mode OCT] [--json] <host> <path>    < content
termilab-cli mcp
termilab-cli guide
termilab-cli help <command>      (or termilab-cli <command> --help)
```

`<host>` is a name or id from `termilab-cli hosts` (names are case-insensitive), or `local`.

### hosts

Prints a table of name, group, `user@host:port` and OS. Hosts that cannot be used right now are marked `(unavailable)`, with the reason on stderr. `--json` prints the full list (`id`, `name`, `group`, `tags`, `os`, `user`, `hostname`, `port`, `auth`, `available`, `note`); it never contains credentials.

```
$ termilab-cli hosts
NAME        GROUP       TARGET                    OS
local       -           derek@workstation         linux
produccion  Clientes    deploy@203.0.113.10:22    ubuntu
backup      -           root@backup.lan:2222      debian
```

### run

Runs one command in a fresh session as that host's user and waits for it. Its stdout and stderr go to termilab-cli's stdout and stderr, and termilab-cli exits with the command's exit code.

| Option | Meaning |
|---|---|
| `--timeout S` | Kill the command after S seconds (default 60, max 3600). |
| `--cwd DIR` | Run in DIR, absolute or `~/relative`. Default: the home directory. Use it instead of `cd`, since nothing carries over between calls. |
| `--json` | Print the full result object (`exit_code`, `stdout`, `stderr`, `timed_out`, `truncated`, `signal`, `duration_ms`, ...) instead of the output. The exit code is still the command's. |
| `--` | End of options. |

Options go before the command. After `<host>`, the first word that is not an option starts the command, and everything from there is passed through untouched, so `termilab-cli run web ls -la` works. The words are joined with spaces and run by the remote login shell, as with `ssh`; quote the whole command to keep pipes and redirections on the remote side.

```bash
termilab-cli run produccion uptime
termilab-cli run --cwd /srv/app produccion "git log --oneline -5"
termilab-cli run --timeout 300 backup "restic snapshots | tail -n 20"
if termilab-cli run produccion "systemctl is-active --quiet nginx"; then echo up; fi
termilab-cli run --json produccion "df -h /" | jq -r .stdout
```

Exit codes: the command's own; **124** if it timed out (it is killed); **128+N** if it was killed by signal N; **125** if it could not be run at all (Termilab not running, unknown host, host key not trusted, authentication failed); **2** for a usage error. Output is capped at 256 KB per stream; a note on stderr says when it was cut.

### read and write

`read` prints a file byte for byte to stdout (text or binary), up to 4 MB; `--max-bytes N` reads less. If the file is larger than what was read, the first part is printed and the exit code is 1. `write` replaces a file with what comes on stdin (up to 4 MB); `--mode` sets the permissions in octal. Paths are absolute or relative to the home directory.

```bash
termilab-cli read produccion /etc/nginx/nginx.conf > nginx.conf
termilab-cli write --mode 644 produccion /etc/nginx/nginx.conf < nginx.conf
termilab-cli run produccion "nginx -t && systemctl reload nginx"
termilab-cli read backup /var/backups/db.sql.gz > db.sql.gz
```

Exit codes: 0 on success, 1 on failure, 2 for a usage error.

### Errors

Errors go to stderr, prefixed with `termilab-cli:`, and are worded so that a bot can pass them on to a person:

- `Termilab is not running. Open Termilab first, then try again.`
- `no host named "prodution" in Termilab. Did you mean: "produccion"? Run termilab-cli hosts for the list.`
- `Termilab has not trusted the host key of produccion (203.0.113.10:22) yet (SHA256:...). Open Termilab, connect to it once and check the key there. Agents never accept host keys.`
- `"web" matches 2 hosts: ... Use the id.`

## Where actions are logged

Every call, from MCP or from the command line, is recorded in Termilab under **Logs**: tool, host, command (or file path and size), exit code, duration and time. The output of commands and the contents of files are never logged. The log is stored locally in `<userData>/data/agent-logs.json` (mode 0600) and is not synchronized to other devices. While an agent has an interactive shell open, the Sessions dock shows it with an `agent` badge.

## Current limitations

- **Windows and macOS are untested.** The `--cli` entry point and the named-pipe transport on Windows are implemented but have not been run on those systems yet. Linux (deb, pacman, AppImage) is tested.
- **No per-host policy yet.** Any host saved in Termilab, plus `local`, can be used by any agent or script running as your user while Termilab is open. There is no switch to turn the API off and no way to exclude a host. Only register Termilab with agents you trust with all of those hosts.
- **Long-running commands are not cancelled** when the caller goes away: if an MCP client or `termilab-cli` is killed during a `run_command`, the command keeps running on the server until it finishes or reaches its timeout.
- **No streaming.** `run` prints the output when the command finishes; for live output use an interactive shell through MCP.
- **Host keys are trusted only from Termilab**, by design. A new server needs one manual connection before agents can use it.
- **Limits:** 256 KB of output per stream for `run_command`, 4 MB per file read or write, one hour maximum per command.
