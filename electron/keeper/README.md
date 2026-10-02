# termilab-keeper

A small static helper that Termilab uploads to a user's Linux server so a shell
(for example an AI agent mid-task) survives SSH disconnects and app quits, and
comes back with the screen restored. No tmux, screen or dtach involved.

- `src/` — C sources (~2.3k lines). `scripts/build-keeper.sh` cross-compiles
  them with `zig cc` (Zig 0.16.0, default `~/opt/zig/zig`, override with `ZIG=`)
  into `bin/termilab-keeper-<KV>-<arch>` for `x86_64`, `aarch64`, `armv7l`
  (armv7-a hard-float) and `riscv64`, all `-static` against musl, plus
  `manifest.json` `{kv, binaries: {arch: {file, sha256, size}}}`. Arch keys are
  what `uname -m` prints on the server. Builds are reproducible: same sources and
  same Zig version give the same sha256.
- `test/run-tests.sh` — the whole verification: reproducible build, static
  check, functional tests through real ptys (`keeper_test.py`), the same tests
  against ASan and UBSan builds, and a random-input fuzz of the frame parser and
  the escape scanner.

`KV` (`KEEPER_VERSION` in `src/keeper.h`) is the keeper's own version, bumped on
any behaviour change. It is independent of Termilab's version and of the wire
protocol version (`KEEPER_PROTO`).

## Model

One daemon per session, like dtach. `attach --create` forks the daemon when the
session does not exist yet (double fork, `setsid`, SIGHUP ignored, umask 077, all
fds closed, `forkpty`, exec `$SHELL` as a login shell — argv[0] `-bash` — falling
back to `/bin/sh`; the environment is inherited from the first attach). The
daemon keeps the pty, a 4 MB ring of raw output and at most one attached client.
Newest attach wins.

## CLI

```
termilab-keeper version                      -> {"keeperVersion":1,"proto":1}
termilab-keeper attach <id> [--cols C --rows R] [--create]
                            [--idle-days N | --idle-seconds N]
termilab-keeper list                         -> one JSON object per line
termilab-keeper kill <id>
```

`<id>` must match `[a-z0-9]{8,40}`; the caller derives it (for example a hash of
its session key). `--cols/--rows` default to the size of the attach client's tty
(else 80x24). `--idle-days` (default 14, `0` = never) is how long the daemon
survives with no client; given on a later attach it replaces the current value.
`--idle-seconds` exists for tests.

`list` fields: `id`, `created`, `lastAttach` (unix seconds), `pid` (daemon),
`shellPid`, `fgCommand` (`/proc/<tcgetpgrp>/comm`), `keeperVersion`, `attached`,
`idleSeconds`. Listing also removes stale sockets left by a crashed daemon.

### Exit codes of `attach`

| code | meaning |
|---|---|
| 0 | the shell exited |
| 75 | replaced: another client attached (one line on stderr) |
| 76 | the session was killed or expired |
| 77 | this client went away (stdin EOF, SIGHUP/SIGTERM); the session lives on |
| 101 | internal error, refused directory, bad arguments |
| 102 | no such session (and no `--create`) |
| 103 | per-user cap of 20 sessions reached; stderr lists the oldest detached |
| 104 | protocol mismatch with a running daemon |

## Files

`~/.termilab/run/` (0700), or `/tmp/termilab-<uid>/` when `$HOME` is so long the
socket path would not fit in `sun_path`. Both directories are refused if they
are a symlink, not owned by the user, or group/world-writable.

| path | what |
|---|---|
| `<id>.sock` | the daemon's socket, 0600. Peers are checked with `SO_PEERCRED` (uid must match) in both directions |
| `<id>.agent` | symlink to the latest attach client's `$SSH_AUTH_SOCK`; the shell's `SSH_AUTH_SOCK` points here, so agent forwarding follows reconnects |
| `.lock` | `flock` serialising creation and stale-socket cleanup |

The daemon binds a temporary name and publishes it with `link()`, so a socket
name is either absent or served. On exit it unlinks the socket only if the inode
is still its own. The shell also gets `TERMILAB_KEEPER_ID=<id>`.

## Wire protocol (proto 1)

Every message is a frame `[type u8][len u32 big-endian][payload]`, `len <= 1 MiB`;
anything larger or an unknown type closes the connection. The first frame on a
connection decides what it is.

| type | name | dir | payload |
|---|---|---|---|
| 1 | HELLO | c→d | `proto u16, cols u16, rows u16, flags u16, idle u32` (flags bit0: idle is set) |
| 1 | HELLO | d→c | `proto u16, kv u16, shellPid u32, daemonPid u32` |
| 2 | DATA | both | raw bytes (pty input / output) |
| 3 | RESIZE | c→d | `cols u16, rows u16` |
| 4 | DETACH | c→d | — |
| 5 | DETACHED | d→c | `reason u8`: 1 replaced, 2 killed, 3 expired |
| 6 | EXIT | d→c | `status u32` (exit code, or 128+signal) |
| 7 | KILL | c→d | — (control connection) |
| 8 | LIST | c→d | — (control connection) |
| 9 | INFO | d→c | the JSON line `list` prints |
| 10 | OK | d→c | — (KILL done) |
| 11 | ERROR | d→c | text |

A connection that sends nothing for 5 s is dropped; at most 16 at once.

## Replay

On attach the daemon sends `ESC c`, then escape sequences restoring the tracked
modes, then the raw ring from a safe boundary, and finally bounces the pty size
(rows-1 for 100 ms, then the real size) so even an app already at that size
gets SIGWINCH and redraws.

The scanner (`src/scan.c`) is a VT parser state machine that renders nothing.
It tracks: alt screen (47/1047/1049), DECCKM, keypad mode, bracketed paste,
mouse tracking (9/1000/1002/1003) and SGR encoding (1006), focus events (1004),
cursor visibility, DECSTBM, current SGR (incl. 256-colour, truecolour and
underline styles), and the window title (OSC 0/2). Three copies run:

- **head** follows live output (current state);
- **tail** is fed the bytes the ring evicts, so it holds the state at the
  oldest byte still in the ring;
- **snap** is head's state right after the last alt-screen entry.

If an app is on the alt screen and its entry is still in the ring, replay starts
there with `snap`'s modes; otherwise it starts at the ring's oldest byte, moved
forward to where `tail` is in ground state on a UTF-8 lead byte. Either way the
terminal ends in head's state (the fuzzer checks this property).

## Limits

- Backpressure: the daemon stops reading the pty while the attached client has
  more than 256 KiB unsent, and drops a client that makes no progress for 60 s
  (it can reattach and replay).
- When the shell exits while nobody is attached, the session ends; its final
  output is not kept.
- Expiry and `kill`: SIGHUP to the shell's process group and the foreground
  group, SIGKILL after 3 s.
