#!/usr/bin/env python3
"""Functional tests for termilab-keeper, driven through real ptys.

usage: keeper_test.py <keeper-binary>
Uses a throwaway $HOME under /tmp so it never touches ~/.termilab.
"""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, tempfile, termios, time

KEEPER = os.path.abspath(sys.argv[1])
HOME = tempfile.mkdtemp(prefix="tk", dir="/tmp")
RUN = os.path.join(HOME, ".termilab", "run")
with open(os.path.join(HOME, ".bash_profile"), "w") as f:
    f.write("PS1='$ '\nunset PROMPT_COMMAND\n")
BASE_ENV = {
    "HOME": HOME, "SHELL": "/bin/bash", "TERM": "xterm-256color",
    "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
}
for k in ("ASAN_OPTIONS", "UBSAN_OPTIONS", "LSAN_OPTIONS"):
    if k in os.environ:
        BASE_ENV[k] = os.environ[k]

results = []


def ok(name, cond, evidence=""):
    results.append((name, bool(cond), evidence))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{evidence}]" if evidence else ""), flush=True)
    return cond


class Client:
    def __init__(self, sid, *extra, cols=80, rows=24, env=None, create=True):
        args = [KEEPER, "attach", sid, "--cols", str(cols), "--rows", str(rows)]
        if create:
            args.append("--create")
        args += list(extra)
        e = dict(BASE_ENV)
        e.update(env or {})
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(KEEPER, args, e)
        self.set_size(cols, rows, signal_it=False)
        self.out = b""
        self.status = None

    def set_size(self, cols, rows, signal_it=True):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def pump(self, t=0.05):
        end = time.time() + t
        while True:
            left = end - time.time()
            r, _, _ = select.select([self.fd], [], [], max(0, left))
            if r:
                try:
                    d = os.read(self.fd, 1 << 16)
                except OSError:
                    d = b""
                if not d:
                    return False
                self.out += d
            elif left <= 0:
                return True

    def expect(self, pat, timeout=10, since=0):
        rx = re.compile(pat if isinstance(pat, bytes) else pat.encode(), re.S)
        end = time.time() + timeout
        while time.time() < end:
            m = rx.search(self.out, since)
            if m:
                return m
            if not self.pump(0.05) and not rx.search(self.out, since):
                break
        return rx.search(self.out, since)

    def send(self, s):
        os.write(self.fd, s.encode() if isinstance(s, str) else s)

    def wait(self, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.05)
            p, st = os.waitpid(self.pid, os.WNOHANG)
            if p:
                self.status = os.waitstatus_to_exitcode(st)
                return self.status
        return None

    def kill(self):
        os.kill(self.pid, signal.SIGKILL)
        self.wait()
        os.close(self.fd)


def keeper(*args, env=None, stdin=None):
    e = dict(BASE_ENV)
    e.update(env or {})
    return subprocess.run([KEEPER, *args], env=e, capture_output=True, text=True, timeout=30,
                          stdin=stdin if stdin is not None else subprocess.DEVNULL)


def sessions(env=None):
    return [json.loads(l) for l in keeper("list", env=env).stdout.splitlines() if l.strip()]


def alive(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().split(") ")[1][0] != "Z"
    except OSError:
        return False


def wait_for(pred, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.1)
    return pred()


def kill_all():
    for s in sessions():
        keeper("kill", s["id"])


def t_version():
    r = keeper("version")
    v = json.loads(r.stdout)
    ok("version runs", r.returncode == 0 and v["keeperVersion"] >= 1 and v["proto"] == 1, r.stdout.strip())


def t_continuity():
    sid = "cont0001"
    c = Client(sid)
    c.send("echo SP=$$ X$((40+2))\r")
    m = c.expect(r"SP=(\d+) X42", 15)
    shell = int(m.group(1)) if m else -1
    c.send("sleep 600 & echo BG=$! Y$((1+2))\r")
    m = c.expect(r"BG=(\d+) Y3")
    bg = int(m.group(1)) if m else -1
    c.send("seq 1 1000000 | tail -3; echo Z$((2+3))\r")
    ok("seq output while attached", c.expect(r"999999\r\n1000000\r\n.*Z5", 20))
    c.send("sleep 2; echo LATE$((3+4))\r")
    time.sleep(0.3)
    c.kill()
    time.sleep(3)
    c2 = Client(sid, create=False)
    m2 = c2.expect(r"LATE7", 10)
    replay = c2.out
    ok("reattach replays output produced while detached", m2 and replay.startswith(b"\x1bc"),
       f"replay {len(replay)} bytes, starts {replay[:2]!r}, has 1000000: {b'1000000' in replay}")
    c2.send("echo SP2=$$ W$((5+5))\r")
    m = c2.expect(r"SP2=(\d+) W10")
    ok("shell pid unchanged", m and int(m.group(1)) == shell, f"before {shell} after {m and m.group(1)}")
    c2.send(f"kill -0 {bg} && echo ALIVE$((1+8))\r")
    ok("background sleep survived", c2.expect(r"ALIVE9") and alive(bg), f"sleep pid {bg}")
    # resize while attached -> SIGWINCH -> RESIZE frame -> pty size
    c2.set_size(100, 30)
    os.kill(c2.pid, signal.SIGWINCH)
    time.sleep(0.4)
    since = len(c2.out)
    c2.send("echo SZ=$(stty size) Q$((1+1))\r")
    m = c2.expect(r"SZ=(\d+ \d+) Q2", since=since)
    ok("resize while attached", m and m.group(1) == b"30 100", m and m.group(1).decode())
    # big output while detached wraps the 4 MB ring
    c2.send("(sleep 1; seq 1 2000000; echo BIG$((9+9))) &\r")
    time.sleep(0.3)
    c2.kill()
    time.sleep(5)
    c3 = Client(sid, create=False, cols=120, rows=40)
    m = c3.expect(r"BIG18", 20)
    n = m.end() if m else 0
    ok("ring wrap: replay bounded to ~4 MB and ends with latest output",
       m and 3_900_000 < n < 4_300_000 and b"2000000" in c3.out and c3.out.startswith(b"\x1bc"),
       f"{n} bytes replayed")
    time.sleep(0.3)
    since = len(c3.out)
    c3.send("echo SZ=$(stty size) Q$((2+2))\r")
    m = c3.expect(r"SZ=(\d+ \d+) Q4", since=since)
    ok("resize while detached (reattach at new size)", m and m.group(1) == b"40 120",
       m and m.group(1).decode())
    c3.send("exit 3\r")
    st = c3.wait()
    ok("shell exit -> client exit 0, socket removed", st == 0 and not os.path.exists(f"{RUN}/{sid}.sock"),
       f"exit {st}")


def restore_prefix(out):
    """Bytes between ESC c and the first byte of the raw replay."""
    i = out.find(b"\x1bc")
    return out[i:i + 200] if i >= 0 else b""


def t_fullscreen(app, start_cmd, ready_pat, key, done_pat, expect_keypad, alt=True):
    sid = f"fs{app}0001"[:12]
    c = Client(sid)
    c.send(start_cmd + "\r")
    got = (not alt or c.expect(r"\x1b\[\?1049h", 15)) and c.expect(ready_pat, 15)
    if not ok(f"{app}: started" + (" in alt screen" if alt else ""), got):
        c.kill()
        keeper("kill", sid)
        return
    time.sleep(0.5)
    c.kill()
    c2 = Client(sid, create=False, cols=90, rows=30)
    c2.expect(ready_pat, 10)
    time.sleep(1.0)
    c2.pump(0.3)
    pre = restore_prefix(c2.out)
    cmd_echo = start_cmd.encode() in c2.out
    if alt:
        good = pre.startswith(b"\x1bc\x1b[?1049h") and not cmd_echo
    else:  # no alt screen (top): replay from ring start re-applies its modes
        tail = c2.out[c2.out.find(b"\x1bc"):]
        good = pre.startswith(b"\x1bc") and b"\x1b[?1h\x1b=" in tail and b"\x1b[?25l" in tail
        pre = tail[:24]
    ok(f"{app}: reattach restores " + ("alt screen" if alt else "DECCKM/keypad/hidden cursor")
       + (" + keypad/DECCKM" if expect_keypad and alt else ""),
       good and (not (expect_keypad and alt) or (b"\x1b[?1h" in pre and b"\x1b=" in pre)),
       f"prefix {pre[:40]!r}; replay starts after last 1049h: {not cmd_echo}")
    since = len(c2.out)
    c2.send(key)
    ok(f"{app}: key works after reattach", c2.expect(done_pat, 10, since=since))
    c2.send("echo DONE$((3+3))\r")
    c2.expect(r"DONE6", 10)
    c2.send("exit\r")
    c2.wait()


def t_vi():
    path = os.path.join(HOME, "vi.txt")
    t_fullscreen("vi", f"vi {path}", r"~", "ihello-keeper\x1b:wq\r", r"\x1b\[\?1049l", False)
    try:
        content = open(path).read()
    except OSError:
        content = ""
    ok("vi: edit after reattach was saved", "hello-keeper" in content, repr(content.strip()))


def t_replaced():
    sid = "repl0001"
    c1 = Client(sid)
    c1.send("echo R$((1+1))\r")
    c1.expect("R2")
    c2 = Client(sid, create=False)
    st = c1.wait()
    ok("second attach -> first exits 75 with one line", st == 75 and b"attached from another connection" in c1.out,
       f"exit {st}")
    c2.send("echo S$((2+1))\r")
    ok("second client works", c2.expect("S3"))
    c2.kill()
    keeper("kill", sid)


def t_list_kill():
    sid = "list0001"
    c = Client(sid)
    c.send("echo L$((1+1)); sleep 30\r")
    c.expect("L2")
    time.sleep(0.5)
    ss = {s["id"]: s for s in sessions()}
    s = ss.get(sid, {})
    keys = {"id", "created", "lastAttach", "pid", "fgCommand", "keeperVersion", "attached"}
    ok("list: JSON line with fields, fgCommand via tcgetpgrp",
       keys <= set(s) and s["fgCommand"] == "sleep" and s["attached"] is True,
       json.dumps(s)[:160])
    r = keeper("kill", sid)
    st = c.wait()
    ok("kill: exit 0, attached client exits 76", r.returncode == 0 and st == 76 and b"session killed" in c.out,
       f"kill rc {r.returncode}, client exit {st}")
    ok("kill: session gone, shell dead", sid not in {x["id"] for x in sessions()}
       and wait_for(lambda: not alive(s.get("shellPid", 0)), 5))
    r = keeper("attach", sid, "--cols", "80", "--rows", "24")
    ok("attach without --create on missing session -> 102", r.returncode == 102, r.stderr.strip())


def t_cap():
    kill_all()
    codes = []
    for i in range(20):
        codes.append(keeper("attach", f"cap{i:05d}", "--create", "--cols", "80", "--rows", "24").returncode)
        if i == 0:
            time.sleep(1.1)  # make cap00000 unambiguously the oldest
    n = len(sessions())
    r = keeper("attach", "cap99999", "--create", "--cols", "80", "--rows", "24")
    ok("cap: 20 sessions allowed, 21st refused (103) listing oldest detached",
       n == 20 and set(codes) == {77} and r.returncode == 103 and "cap00000" in r.stderr,
       f"{n} live; 21st rc {r.returncode}: {r.stderr.strip()[:90]}")
    kill_all()
    ok("cap: cleanup", len(sessions()) == 0)


def t_expiry():
    sid = "expi0001"
    c = Client(sid, "--idle-seconds", "3")
    c.send("sleep 600 & echo BG=$! E$((1+1))\r")
    m = c.expect(r"BG=(\d+) E2")
    bg = int(m.group(1)) if m else 0
    time.sleep(4)  # attached: must not expire
    still = sid in {s["id"] for s in sessions()}
    c.kill()
    gone = wait_for(lambda: sid not in {s["id"] for s in sessions()}, 10)
    ok("expiry: survives while attached, exits ~3 s after detach, SIGHUPs jobs",
       still and gone and wait_for(lambda: not alive(bg), 5), f"attached-alive {still}, expired {gone}")


def t_agent():
    sid = "agnt0001"
    c = Client(sid, env={"SSH_AUTH_SOCK": "/tmp/fake-agent-1"})
    c.send("echo A=$(readlink $SSH_AUTH_SOCK) $SSH_AUTH_SOCK\r")
    m1 = c.expect(r"A=(/\S+) (/\S+)")
    c.kill()
    c2 = Client(sid, create=False, env={"SSH_AUTH_SOCK": "/tmp/fake-agent-2"})
    time.sleep(0.5)
    since = len(c2.out)
    c2.send("echo B=$(readlink $SSH_AUTH_SOCK)\r")
    m2 = c2.expect(r"B=(/\S+)\r", since=since)
    ok("agent symlink follows the latest attach",
       m1 and m1.group(1) == b"/tmp/fake-agent-1" and m1.group(2).endswith(b"/agnt0001.agent")
       and m2 and m2.group(1) == b"/tmp/fake-agent-2",
       f"{m1 and m1.group(1).decode()} -> {m2 and m2.group(1).decode()}")
    c2.kill()
    keeper("kill", sid)


def t_security():
    sid = "secu0001"
    keeper("attach", sid, "--create", "--cols", "80", "--rows", "24")
    sm = os.stat(f"{RUN}/{sid}.sock").st_mode & 0o777
    dm = os.stat(RUN).st_mode & 0o777
    ok("socket 0600, run dir 0700", sm == 0o600 and dm == 0o700, f"{oct(sm)} {oct(dm)}")
    keeper("kill", sid)
    os.chmod(RUN, 0o770)
    r = keeper("attach", sid, "--create", "--cols", "80", "--rows", "24")
    os.chmod(RUN, 0o700)
    ok("refuses group-writable run dir", r.returncode == 101 and "refusing" in r.stderr, r.stderr.strip())
    h2 = tempfile.mkdtemp(prefix="tks", dir="/tmp")
    real = tempfile.mkdtemp(prefix="tkr", dir="/tmp")
    os.symlink(real, os.path.join(h2, ".termilab"))
    r = keeper("attach", sid, "--create", "--cols", "80", "--rows", "24", env={"HOME": h2})
    ok("refuses symlinked ~/.termilab", r.returncode == 101 and "refusing" in r.stderr, r.stderr.strip())
    shutil.rmtree(h2)
    shutil.rmtree(real)
    bad = [keeper("attach", x, "--create").returncode for x in ("short", "UPPERCASE1", "a/b/../c1234", "x" * 41)]
    ok("invalid ids rejected", bad == [101] * 4, str(bad))
    longhome = os.path.join(HOME, "l" * 60)
    os.makedirs(longhome)
    r = keeper("attach", "long0001", "--create", "--cols", "80", "--rows", "24", env={"HOME": longhome})
    fb = f"/tmp/termilab-{os.getuid()}"
    exists = os.path.exists(f"{fb}/long0001.sock")
    fm = os.stat(fb).st_mode & 0o777 if os.path.exists(fb) else 0
    keeper("kill", "long0001", env={"HOME": longhome})
    ok("long $HOME falls back to /tmp/termilab-<uid> (0700)", exists and fm == 0o700, f"{fb} {oct(fm)}")


def t_stale():
    sid = "stal0001"
    keeper("attach", sid, "--create", "--cols", "80", "--rows", "24")
    s = {x["id"]: x for x in sessions()}.get(sid, {})
    os.kill(s.get("pid", 0), signal.SIGKILL)
    wait_for(lambda: not alive(s.get("pid", 0)), 5)
    left = os.path.exists(f"{RUN}/{sid}.sock")
    r1 = keeper("attach", sid, "--cols", "80", "--rows", "24")
    c = Client(sid)
    c.send("echo N$((4+4))\r")
    fresh = c.expect("N8")
    s2 = {x["id"]: x for x in sessions()}.get(sid, {})
    ok("crashed daemon: stale socket -> 102 without --create, recreated with it",
       left and r1.returncode == 102 and fresh and s2.get("pid") not in (None, s.get("pid")),
       f"stale left {left}, rc {r1.returncode}, new pid {s2.get('pid')}")
    c.kill()
    keeper("kill", sid)


def main():
    tests = [t_version, t_continuity,
             lambda: t_fullscreen("less", "seq 1 500 | less", r"\r\n:", "q", r"\x1b\[\?1049l", True),
             t_vi,
             lambda: t_fullscreen("top", "top -d 1", r"load average", "q", r"\x1b\[\?25h", True, alt=False),
             t_replaced, t_list_kill, t_stale, t_cap, t_expiry, t_agent, t_security]
    try:
        for t in tests:
            try:
                t()
            except Exception as e:  # a crashed test is a failed test
                ok(getattr(t, "__name__", "test"), False, f"exception {e!r}")
    finally:
        kill_all()
        shutil.rmtree(HOME, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
