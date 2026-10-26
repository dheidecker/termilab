/**
 * The agent-facing guide: how an AI agent should use Termilab. One text, three
 * readers: the MCP resource `termilab://guide` and prompt `termilab_usage`
 * (mcp.js), `termilab-cli guide` (cli.js), and the section of docs/agents.md
 * between the `agent-guide` markers (scripts/lib/check-agent.js keeps that
 * section identical to this string).
 */
const GUIDE = `# Using Termilab as an AI agent

Termilab is an SSH client running on the user's computer. Through it you can work on the user's saved servers without ever seeing a password or key: you name a host, Termilab logs in with the credentials it already holds, and you get the result. You do not need credentials and must not ask the user for them.

## Hosts

- Start with \`list_hosts\` (CLI: \`termilab-cli hosts --json\`). Use a host's \`name\` or \`id\` from that list in every other call.
- \`local\` is always available: it is this computer, in the user's login shell.
- \`available: false\` means the host cannot be used right now; its \`note\` says why (for example a password saved on another computer). Tell the user what the note says.
- On each host you act as that host's saved user, with exactly that user's permissions, root or sudo included. Be as careful as the user would be.

## One-off commands: run_command

Each call runs in a fresh session: nothing (current directory, variables, sudo session) carries over to the next call. Use \`cwd\` instead of \`cd\`.

    run_command {"host": "produccion", "command": "docker ps", "cwd": "/srv/app"}

Returns \`exit_code\`, \`stdout\`, \`stderr\`, \`timed_out\`, \`truncated\`, \`duration_ms\`. Default timeout 60 s (\`timeout_s\`, max 3600). Each stream is capped at 256 KB: filter remotely (\`| tail -n 200\`, \`grep\`) instead of printing everything. There is no terminal: a command that asks a question (sudo password, \`[Y/n]\`) hangs until the timeout. Use a non-interactive form (\`apt-get -y\`, \`sudo -n\`) or an interactive shell.

## Interactive and multi-step work: open_shell

For anything that needs state or answers prompts (navigating with \`cd\`, environment variables, \`sudo\` asking for a password, \`[Y/n]\` questions, deploy scripts, REPLs):

1. \`open_shell {"host": "produccion"}\` returns \`session_id\`.
2. \`read_output {"session_id": "...", "wait_ms": 2000}\` to see the login banner and prompt.
3. \`send_input {"session_id": "...", "data": "cd /srv/app && ./deploy.sh\\n"}\`: end each command with \`\\n\` (Enter).
4. \`read_output\` again, repeatedly, until the output stops growing and the shell prompt (or a question) is back. Output is raw terminal text and may contain escape codes.
5. Answer prompts with \`send_input\` (\`"y\\n"\`). \`"\\u0003"\` is Ctrl-C.
6. \`close_shell {"session_id": "..."}\` when done. Idle shells close after 15 minutes; \`closed: true\` and \`exit_code\` in \`read_output\` mean the shell has exited.

When sudo asks for a password you do not have it: stop and tell the user (they can run that step themselves in Termilab, or allow it without a password). Never guess or invent one.

## Files: read_file and write_file

Over SFTP (or the local disk for \`local\`). Paths are absolute or relative to the home directory (\`~\` allowed).

    read_file  {"host": "produccion", "path": "/etc/nginx/nginx.conf"}
    write_file {"host": "produccion", "path": "~/app/.env", "content": "PORT=8080\\n", "mode": "600"}

Text comes back as utf-8, other files as base64 (see \`encoding\`). Reads default to 256 KB (\`max_bytes\` up to 4 MB, \`truncated: true\` if cut); writes up to 4 MB and replace the whole file. To change a config: read it, edit, write it back, then verify (for example \`nginx -t\`).

## Destructive commands need the user's approval

You may run anything, except operations that destroy a project or a database: those pause until the user clicks **Run once** in Termilab (up to 2 minutes). This applies to \`run_command\` and to lines typed with \`send_input\`, on every host including \`local\`, also behind \`sudo\`, \`sh -c\`, \`ssh\`, \`docker exec\`, pipes and heredocs:

- Recursive deletes (\`rm -r\`, \`find … -delete\`, \`find … -exec rm\`) of anything that is not \`/tmp\`, \`/var/tmp\`, \`node_modules\`, \`.cache\`, \`dist\`, \`build\`, \`__pycache__\` or \`vendor\` (home, \`/srv\`, \`/var/www\`, \`/opt\`, \`/var/lib\`, a project folder, \`.\`, a variable).
- \`git reset --hard\`, \`git clean -fdx\`, force push (\`--force\`, \`-f\`, \`--force-with-lease\`, \`+ref\`) to main/master or without naming the branch.
- SQL \`DROP DATABASE|SCHEMA|TABLE\`, \`TRUNCATE\`, \`DELETE FROM\` without \`WHERE\`; \`dropdb\`, \`mysqladmin drop\`; Mongo \`dropDatabase()\` / \`.drop()\`; Redis \`FLUSHALL\` / \`FLUSHDB\`.
- Database resets: \`artisan migrate:fresh|refresh|reset\`, \`db:wipe\`, Rails \`db:drop|reset|schema:load\`, \`prisma migrate reset\`, \`prisma db push --force-reset\`, Django \`flush\` / \`reset_db\`, \`sequelize db:drop\`, \`knex migrate:rollback --all\`, \`typeorm schema:drop\`.
- Data volumes: \`docker volume rm|prune\`, \`docker system prune --volumes\`, \`docker compose down -v\`, \`podman volume rm|prune\`.

If the user approves, exactly that command runs, that once. If the result is "Blocked: this command was classified as … and the user did not approve it", stop: do not retry it, rephrase it, split it up or reach the same result another way. Tell the user what you wanted to do and why, and let them decide.

## Talking to another agent: list_sessions and send_to_session

The user may have other AI agents (Claude Code, Codex, ...) running in other Termilab terminals, each with an alias they gave it ("sempat", "backend"). When asked "ask the sempat session ...", message that agent directly:

1. \`list_sessions\` (CLI: \`termilab-cli sessions\`): every open terminal with \`session\` (its alias, or a short id), \`host\`, \`agent\` (\`claude\`, \`codex\`, ... or null), \`state\` (\`working\`, \`idle\`, \`waiting-permission\`, \`unknown\`), \`reachable\` and \`queued\` (messages from agents waiting their turn there). \`self: true\` is the terminal you run in.
2. \`send_to_session {"session": "sempat", "message": "Which migration did you just add?"}\` types the message into that agent's input box, as if the user typed it, waits for its turn to end and returns \`reply\`, \`state\`, \`truncated\` and \`timedOut\` (CLI: \`termilab-cli send sempat "..."\`).
3. A long task: \`timeoutSec\` (default 600, max 3600), or \`"wait": false\` and later \`wait_reply {"session": "sempat"}\`. \`timedOut: true\` returns what it has written so far: call \`wait_reply\` to keep waiting.

The other agent sees the message prefixed with \`[Message from Termilab session "<your alias>" · ref <id>]\` (or \`an agent outside Termilab (unverified)\` when you do not run in a Termilab terminal). It does not see your conversation: make the message self-contained, and say what answer you need. Control characters are removed from the message, and without bracketed paste its lines are joined with spaces.

Rules:

- Only sessions with \`reachable: true\`: an agent CLI Termilab recognises. Never a plain shell (the text would run as commands), never your own session, never one in the background, never one the user blocked ("Don't let agents message this session").
- A session waiting for a permission prompt or a question is refused and nothing is typed: the user has to answer it first. If it stops to ask during your message, \`state\` is \`waiting-permission\`: tell the user.
- A busy session (\`working\`) still gets the message: the agent queues it (\`queued: true\`), and the reply comes after its current turn.
- One message at a time per session: if another agent's message to it is still waiting for its answer, yours waits its turn (\`queued\` in \`list_sessions\` counts them), and that time counts against your \`timeoutSec\`.
- Up to 8000 characters per message and 30 messages per hour per session. Do not start a back-and-forth loop between agents; when in doubt, ask the user.
- Every message is recorded in Termilab's Logs (from, to, length, result).

## Errors and what to do

- "Termilab is not running": ask the user to open Termilab, then retry.
- Host key not trusted yet, or CHANGED: ask the user to connect to that host once from Termilab and check the key there. Agents can never accept host keys. A changed key can mean an attack: do not work around it.
- "No host named ...": call \`list_hosts\` and use an exact name or id.
- "matches N hosts": use the \`id\` instead of the name.
- Authentication failed: the credentials saved in Termilab are wrong; ask the user to fix the host in Termilab.
- "Connection to ... was lost while ...": the network or the server dropped mid-call and it was NOT retried. The command may or may not have run: check its effect before running it again.
- "Blocked: …": the user did not approve a destructive command (see above). Do not retry or work around it; ask the user.

Every call is recorded in Termilab's Logs (tool, host, command, exit code, duration; never the output or file contents).

## Command line (no MCP)

The same actions from a shell: \`termilab-cli hosts\`, \`termilab-cli sessions\`, \`termilab-cli send [--no-wait] [--timeout S] <session> <message...>\`, \`termilab-cli run [--cwd DIR] [--timeout S] <host> <command...>\` (exits with the command's exit code, 124 on timeout, 125 if it could not run), \`termilab-cli read <host> <path>\`, \`termilab-cli write [--mode 644] <host> <path> < file\`. Add \`--json\` for the full result.
`;

module.exports = { GUIDE };
