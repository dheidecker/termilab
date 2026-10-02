/* The per-session daemon: owns the pty, the replay ring and at most one
 * attached client. Single-threaded, everything nonblocking behind poll(). */
#include "keeper.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#ifndef SYS_close_range
#define SYS_close_range 436
#endif

#define MAXCONN 16
#define TOSHELL_MAX (2u << 20)
#define STALL_MS 60000

enum { C_FREE, C_PENDING, C_ATTACHED, C_CLOSING, C_KILLER };

struct conn {
	int fd, role;
	struct buf in, out;
	int64_t deadline, progress;
};

static struct {
	const char *id;
	char sock[SUN_MAX];
	dev_t sdev;
	ino_t sino;
	int lfd, mfd, sigr, sigw, m_eof;
	pid_t shell;
	int shell_done, shell_status, dying;
	int64_t die_deadline, winch_at;
	struct conn c[MAXCONN];
	int att;
	struct ring ring;
	struct scan head, tail, snap;
	int snap_valid;
	uint64_t snap_off;
	struct buf toshell;
	time_t created, last_attach, last_detach;
	uint32_t idle;
	uint16_t cols, rows;
} d;

static volatile sig_atomic_t g_term;

static void on_sig(int sig)
{
	int e = errno;
	char b = (char)sig;
	if (sig == SIGTERM)
		g_term = 1;
	(void)!write(d.sigw, &b, 1);
	errno = e;
}

static void close_other_fds(int keep)
{
	if (keep > 3)
		syscall(SYS_close_range, 3u, (unsigned)keep - 1, 0u);
	if (syscall(SYS_close_range, (unsigned)keep + 1, ~0u, 0u) == 0)
		return;
	for (int fd = 3; fd < 65536; fd++) /* pre-5.9 kernels */
		if (fd != keep)
			close(fd);
}

static void set_size(uint16_t cols, uint16_t rows)
{
	struct winsize ws;
	memset(&ws, 0, sizeof ws);
	ws.ws_col = cols;
	ws.ws_row = rows;
	ioctl(d.mfd, TIOCSWINSZ, &ws);
}

static void conn_close(int i)
{
	struct conn *c = &d.c[i];
	if (c->role == C_FREE)
		return;
	if (i == d.att) {
		d.att = -1;
		d.last_detach = time(NULL);
	}
	close(c->fd);
	buf_free(&c->in);
	buf_free(&c->out);
	c->role = C_FREE;
}

static int queue(int i, int type, const void *p, size_t n)
{
	if (frame_put(&d.c[i].out, type, p, n) < 0) {
		conn_close(i); /* client too far behind: it can reattach and replay */
		return -1;
	}
	return 0;
}

static void retire(int i, int64_t now)
{
	if (i == d.att) {
		d.att = -1;
		d.last_detach = time(NULL);
	}
	d.c[i].role = C_CLOSING;
	d.c[i].deadline = now + 2000;
}

static void unlink_own_sock(void)
{
	struct stat st;
	if (d.lfd < 0)
		return;
	if (lstat(d.sock, &st) == 0 && st.st_dev == d.sdev && st.st_ino == d.sino)
		unlink(d.sock);
	close(d.lfd); /* after unlink: until then a creator sees us as live */
	d.lfd = -1;
}

static void hup_shell(int sig)
{
	if (d.shell_done)
		return;
	pid_t fg = tcgetpgrp(d.mfd);
	kill(-d.shell, sig);
	if (fg > 0 && fg != d.shell)
		kill(-fg, sig);
}

static void begin_die(int reason, int64_t now)
{
	if (d.dying)
		return;
	d.dying = 1;
	d.die_deadline = now + 3000;
	unlink_own_sock();
	if (d.att >= 0) {
		int a = d.att;
		uint8_t r = (uint8_t)reason;
		if (queue(a, F_DETACHED, &r, 1) == 0)
			retire(a, now);
	}
	hup_shell(SIGHUP);
}

static void reap(void)
{
	int st;
	pid_t r;
	while ((r = waitpid(-1, &st, WNOHANG)) > 0) {
		if (r == d.shell) {
			d.shell_done = 1;
			d.shell_status = WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st);
		}
	}
}

static void flush_all(int ms)
{
	int64_t end = mono_ms() + ms;
	for (;;) {
		struct pollfd pf[MAXCONN];
		int idx[MAXCONN], n = 0;
		for (int i = 0; i < MAXCONN; i++)
			if (d.c[i].role != C_FREE && buf_pending(&d.c[i].out)) {
				pf[n].fd = d.c[i].fd;
				pf[n].events = POLLOUT;
				pf[n].revents = 0;
				idx[n++] = i;
			}
		int64_t left = end - mono_ms();
		if (n == 0 || left <= 0)
			return;
		if (poll(pf, (nfds_t)n, (int)left) < 0 && errno != EINTR)
			return;
		for (int k = 0; k < n; k++)
			if (pf[k].revents && buf_flush(pf[k].fd, &d.c[idx[k]].out) < 0)
				conn_close(idx[k]);
	}
}

static void finish(void) __attribute__((noreturn));
static void finish(void)
{
	unlink_own_sock();
	for (int i = 0; i < MAXCONN; i++)
		if (d.c[i].role == C_KILLER)
			queue(i, F_OK, NULL, 0);
	flush_all(1000);
	if (!d.shell_done)
		kill(-d.shell, SIGKILL);
	exit(0); /* not _exit: lets a sanitizer build run its leak check */
}

static void on_output(const uint8_t *p, size_t n)
{
	uint64_t base = d.ring.head;
	ring_write(&d.ring, &d.tail, p, n);
	for (size_t off = 0; off < n;) {
		off += scan_feed(&d.head, p + off, n - off);
		if (d.head.ev_alt) {
			d.snap = d.head;
			d.snap_valid = 1;
			d.snap_off = base + off;
		}
	}
	if (d.att >= 0)
		queue(d.att, F_DATA, p, n);
}

static void read_master(int max_reads)
{
	uint8_t b[IO_CHUNK];
	while (!d.m_eof && max_reads-- > 0) {
		ssize_t n = read(d.mfd, b, sizeof b);
		if (n > 0) {
			on_output(b, (size_t)n);
			continue;
		}
		if (n < 0 && errno == EINTR)
			continue;
		if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK))
			d.m_eof = 1; /* EIO: every slave fd is closed */
		return;
	}
}

static void send_replay(int i)
{
	static uint8_t chunk[IO_CHUNK];
	char pre[1100];
	struct scan base;
	uint64_t start, rs = ring_start(&d.ring);
	if (d.head.alt && d.snap_valid && d.snap_off >= rs) {
		base = d.snap; /* full-screen app: replay from its last alt-screen entry */
		start = d.snap_off;
	} else {
		base = d.tail;
		start = rs;
		uint64_t lim = rs + IO_CHUNK;
		while (start < d.ring.head) {
			uint8_t b;
			ring_copy(&d.ring, start, &b, 1);
			if ((scan_ground(&base) || start >= lim) && (b & 0xc0) != 0x80)
				break;
			scan_feed(&base, &b, 1);
			start++;
		}
	}
	pre[0] = 033;
	pre[1] = 'c';
	size_t n = 2 + scan_restore(&base, pre + 2, sizeof pre - 2);
	if (queue(i, F_DATA, pre, n) < 0)
		return;
	while (start < d.ring.head) {
		size_t k = ring_copy(&d.ring, start, chunk, sizeof chunk);
		if (k == 0 || queue(i, F_DATA, chunk, k) < 0)
			return;
		start += k;
	}
}

static void send_info(int i)
{
	char comm[64] = "", ecomm[400], json[1024], path[64];
	pid_t fg = tcgetpgrp(d.mfd);
	if (fg > 0) {
		snprintf(path, sizeof path, "/proc/%d/comm", (int)fg);
		int fd = open(path, O_RDONLY | O_CLOEXEC);
		if (fd >= 0) {
			ssize_t r = read(fd, comm, sizeof comm - 1);
			comm[r > 0 ? r : 0] = 0;
			comm[strcspn(comm, "\n")] = 0;
			close(fd);
		}
	}
	json_str(ecomm, sizeof ecomm, comm);
	int n = snprintf(json, sizeof json,
	                 "{\"id\":\"%s\",\"created\":%lld,\"lastAttach\":%lld,\"pid\":%d,"
	                 "\"shellPid\":%d,\"fgCommand\":\"%s\",\"keeperVersion\":%d,"
	                 "\"attached\":%s,\"idleSeconds\":%u}",
	                 d.id, (long long)d.created, (long long)d.last_attach, (int)getpid(),
	                 (int)d.shell, ecomm, KEEPER_VERSION, d.att >= 0 ? "true" : "false",
	                 (unsigned)d.idle);
	if (n > 0 && (size_t)n < sizeof json)
		queue(i, F_INFO, json, (size_t)n);
}

static void handle_hello(int i, const struct frame *f, int64_t now)
{
	if (f->len < 8) {
		conn_close(i);
		return;
	}
	uint16_t proto = get16(f->p), cols = get16(f->p + 2), rows = get16(f->p + 4);
	uint16_t flags = get16(f->p + 6);
	if (proto != KEEPER_PROTO) {
		static const char msg[] = "protocol version mismatch";
		if (queue(i, F_ERROR, msg, sizeof msg - 1) == 0)
			retire(i, now);
		return;
	}
	if ((flags & 1) && f->len >= 12)
		d.idle = get32(f->p + 8);
	if (cols < 1)
		cols = 1;
	if (rows < 1)
		rows = 1;
	if (d.att >= 0) {
		int o = d.att;
		uint8_t r = R_REPLACED;
		if (queue(o, F_DETACHED, &r, 1) == 0)
			retire(o, now);
	}
	d.c[i].role = C_ATTACHED;
	d.c[i].progress = now;
	d.att = i;
	d.last_attach = time(NULL);
	uint8_t ack[12];
	put16(ack, KEEPER_PROTO);
	put16(ack + 2, KEEPER_VERSION);
	put32(ack + 4, (uint32_t)d.shell);
	put32(ack + 8, (uint32_t)getpid());
	if (queue(i, F_HELLO, ack, sizeof ack) < 0)
		return;
	send_replay(i);
	/* Bounce the size so even an app at the same size gets SIGWINCH and redraws. */
	d.cols = cols;
	d.rows = rows;
	set_size(cols, rows > 1 ? rows - 1 : rows + 1);
	d.winch_at = now + 100;
}

static void handle_frame(int i, const struct frame *f, int64_t now)
{
	struct conn *c = &d.c[i];
	if (c->role == C_PENDING && d.dying) {
		conn_close(i);
		return;
	}
	if (c->role == C_PENDING) {
		if (f->type == F_HELLO) {
			handle_hello(i, f, now);
		} else if (f->type == F_LIST) {
			send_info(i);
			if (c->role != C_FREE)
				retire(i, now);
		} else if (f->type == F_KILL) {
			c->role = C_KILLER;
			begin_die(R_KILLED, now);
		} else {
			conn_close(i);
		}
		return;
	}
	if (c->role != C_ATTACHED)
		return;
	switch (f->type) {
	case F_DATA:
		buf_append(&d.toshell, f->p, f->len); /* cannot overflow: reads stop at 1 MB */
		break;
	case F_RESIZE:
		if (f->len >= 4) {
			d.cols = get16(f->p);
			d.rows = get16(f->p + 2);
			if (d.cols < 1)
				d.cols = 1;
			if (d.rows < 1)
				d.rows = 1;
			if (!d.winch_at)
				set_size(d.cols, d.rows);
		}
		break;
	case F_DETACH:
		conn_close(i);
		break;
	default:
		conn_close(i);
		break;
	}
}

static void read_conn(int i, int64_t now)
{
	uint8_t b[IO_CHUNK];
	struct conn *c = &d.c[i];
	ssize_t n = read(c->fd, b, sizeof b);
	if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK))
		return;
	if (n <= 0 || buf_append(&c->in, b, (size_t)n) < 0) {
		conn_close(i);
		return;
	}
	struct frame f;
	int r;
	while (c->role == C_PENDING || c->role == C_ATTACHED) {
		r = frame_get(&c->in, &f);
		if (r == 0)
			break;
		if (r < 0) {
			conn_close(i);
			break;
		}
		handle_frame(i, &f, now);
	}
}

static void accept_conns(int64_t now)
{
	for (;;) {
		int fd = accept4(d.lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
		if (fd < 0)
			return; /* EAGAIN, or a transient error: poll will tell us again */
		struct ucred cr;
		socklen_t cl = sizeof cr;
		int slot = -1;
		if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &cl) == 0 && cr.uid == getuid())
			for (int i = 0; i < MAXCONN && slot < 0; i++)
				if (d.c[i].role == C_FREE)
					slot = i;
		if (slot < 0) {
			close(fd);
			continue;
		}
		struct conn *c = &d.c[slot];
		memset(c, 0, sizeof *c);
		c->fd = fd;
		c->role = C_PENDING;
		c->in.max = IN_MAX;
		c->out.max = OUT_MAX;
		c->deadline = now + 5000;
	}
}

static void exec_shell(const struct paths *p) __attribute__((noreturn));
static void exec_shell(const struct paths *p)
{
	static const int sigs[] = { SIGHUP, SIGPIPE, SIGTERM, SIGCHLD, SIGINT, SIGQUIT };
	sigset_t none;
	char agent[SUN_MAX], a0[256];
	for (size_t i = 0; i < sizeof sigs / sizeof sigs[0]; i++)
		signal(sigs[i], SIG_DFL); /* SIG_IGN would survive exec */
	sigemptyset(&none);
	sigprocmask(SIG_SETMASK, &none, NULL);
	if (sess_path(p, d.id, ".agent", agent, sizeof agent) == 0)
		setenv("SSH_AUTH_SOCK", agent, 1);
	setenv("TERMILAB_KEEPER_ID", d.id, 1);
	const char *term = getenv("TERM");
	if (!term || !*term)
		setenv("TERM", "xterm-256color", 1);
	const char *sh = getenv("SHELL");
	if (!sh || sh[0] != '/' || access(sh, X_OK) != 0)
		sh = "/bin/sh";
	const char *bn = strrchr(sh, '/');
	snprintf(a0, sizeof a0, "-%s", bn ? bn + 1 : sh); /* leading '-' = login shell */
	char *argv[] = { a0, NULL };
	execv(sh, argv);
	char *fb[] = { (char *)"-sh", NULL };
	execv("/bin/sh", fb);
	_exit(127);
}

static void fail(int readyfd, const char *what) __attribute__((noreturn));
static void fail(int readyfd, const char *what)
{
	char msg[300];
	int n = snprintf(msg, sizeof msg, "E%s: %s", what, strerror(errno));
	if (n > 0)
		(void)!write(readyfd, msg, (size_t)n < sizeof msg ? (size_t)n : sizeof msg - 1);
	if (d.lfd >= 0)
		unlink_own_sock();
	_exit(1);
}

static int make_listener(const struct paths *p, int readyfd)
{
	struct sockaddr_un sa;
	char tmp[SUN_MAX];
	memset(&sa, 0, sizeof sa);
	sa.sun_family = AF_UNIX;
	if (sess_path(p, d.id, ".sock", d.sock, sizeof d.sock) < 0 ||
	    snprintf(tmp, sizeof tmp, "%s/%s.%d.tmp", p->dir, d.id, (int)getpid()) >= (int)sizeof tmp) {
		errno = ENAMETOOLONG;
		fail(readyfd, "socket path");
	}
	memcpy(sa.sun_path, tmp, strlen(tmp) + 1);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
	if (fd < 0)
		fail(readyfd, "socket");
	unlink(tmp);
	if (bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0)
		fail(readyfd, "bind");
	if (chmod(tmp, 0600) < 0 || listen(fd, 16) < 0) {
		unlink(tmp);
		fail(readyfd, "listen");
	}
	/* Publish atomically: link() refuses to replace an existing name. */
	for (int tries = 0;; tries++) {
		if (link(tmp, d.sock) == 0)
			break;
		int e = errno, probe = e == EEXIST && tries == 0 ? connect_sock(d.sock) : -1;
		if (probe >= 0) { /* someone else already serves this id */
			close(probe);
			unlink(tmp);
			(void)!write(readyfd, "OK", 2);
			_exit(0);
		}
		if (e != EEXIST || tries > 0) {
			unlink(tmp);
			errno = e;
			fail(readyfd, "link");
		}
		remove_stale(d.sock);
	}
	unlink(tmp);
	struct stat st;
	if (lstat(d.sock, &st) < 0)
		fail(readyfd, "stat");
	d.sdev = st.st_dev;
	d.sino = st.st_ino;
	return fd;
}

void daemon_main(const struct paths *p, const char *id, uint16_t cols, uint16_t rows,
                 uint32_t idle, int readyfd)
{
	struct sigaction sa;
	int sp[2];
	memset(&d, 0, sizeof d);
	d.id = id;
	d.lfd = d.mfd = -1;
	d.att = -1;
	d.idle = idle;
	umask(077);
	int nul = open("/dev/null", O_RDWR | O_CLOEXEC);
	if (nul >= 0) {
		dup2(nul, 0);
		dup2(nul, 1);
		dup2(nul, 2);
		if (nul > 2)
			close(nul);
	}
	close_other_fds(readyfd);
	if (pipe2(sp, O_CLOEXEC | O_NONBLOCK) < 0)
		fail(readyfd, "pipe");
	d.sigr = sp[0];
	d.sigw = sp[1];
	memset(&sa, 0, sizeof sa);
	sigemptyset(&sa.sa_mask);
	sa.sa_handler = SIG_IGN;
	sigaction(SIGHUP, &sa, NULL);
	sigaction(SIGPIPE, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	sa.sa_handler = on_sig;
	sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
	sigaction(SIGCHLD, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);

	d.ring.p = malloc(RING_SIZE);
	if (!d.ring.p)
		fail(readyfd, "malloc");
	scan_init(&d.head);
	scan_init(&d.tail);
	d.toshell.max = TOSHELL_MAX;
	d.lfd = make_listener(p, readyfd);

	struct winsize ws;
	memset(&ws, 0, sizeof ws);
	ws.ws_col = cols ? cols : 80;
	ws.ws_row = rows ? rows : 24;
	d.cols = ws.ws_col;
	d.rows = ws.ws_row;
	pid_t pid = forkpty(&d.mfd, NULL, NULL, &ws);
	if (pid < 0)
		fail(readyfd, "forkpty");
	if (pid == 0)
		exec_shell(p);
	d.shell = pid;
	if (fcntl(d.mfd, F_SETFD, FD_CLOEXEC) < 0 || set_nonblock(d.mfd, 1) < 0)
		fail(readyfd, "pty");
	d.created = d.last_attach = d.last_detach = time(NULL);
	(void)!write(readyfd, "OK", 2);
	close(readyfd);

	for (;;) {
		int64_t now = mono_ms();
		if (g_term) {
			g_term = 0;
			begin_die(R_KILLED, now);
		}
		reap();
		if (d.shell_done && !d.dying) {
			set_nonblock(d.mfd, 1);
			read_master(64); /* last words of the shell */
			if (d.att >= 0) {
				uint8_t st[4];
				int a = d.att;
				put32(st, (uint32_t)d.shell_status);
				if (queue(a, F_EXIT, st, 4) == 0)
					retire(a, now);
			}
			finish();
		}
		if (d.dying) {
			if (d.shell_done)
				finish();
			if (now >= d.die_deadline) {
				kill(-d.shell, SIGKILL);
				while (waitpid(d.shell, NULL, 0) < 0 && errno == EINTR)
					;
				d.shell_done = 1;
				finish();
			}
		}
		time_t wall = time(NULL);
		if (!d.dying && d.att < 0 && d.idle && wall - d.last_detach >= (time_t)d.idle) {
			begin_die(R_EXPIRED, now);
			continue;
		}
		if (d.winch_at && now >= d.winch_at) {
			set_size(d.cols, d.rows);
			d.winch_at = 0;
		}

		int64_t timeout = 60000;
		struct pollfd pf[3 + MAXCONN];
		int idx[3 + MAXCONN], np = 0;
		for (int i = 0; i < MAXCONN; i++) {
			struct conn *c = &d.c[i];
			if (c->role == C_FREE)
				continue;
			size_t pend = buf_pending(&c->out);
			if ((c->role == C_PENDING || c->role == C_CLOSING) && now >= c->deadline) {
				conn_close(i);
				continue;
			}
			if (c->role == C_CLOSING && pend == 0) {
				conn_close(i);
				continue;
			}
			if (c->role == C_ATTACHED && pend > HIGH_WATER && now - c->progress > STALL_MS) {
				conn_close(i);
				continue;
			}
			if (c->role == C_ATTACHED && pend <= HIGH_WATER)
				c->progress = now;
			short ev = 0;
			if (c->role == C_PENDING ||
			    (c->role == C_ATTACHED && buf_pending(&d.toshell) < MAX_FRAME))
				ev |= POLLIN;
			if (pend)
				ev |= POLLOUT;
			if (c->role == C_PENDING || c->role == C_CLOSING)
				timeout = c->deadline - now < timeout ? c->deadline - now : timeout;
			if (c->role == C_ATTACHED && pend > HIGH_WATER)
				timeout = timeout > 1000 ? 1000 : timeout;
			pf[np].fd = c->fd;
			pf[np].events = ev;
			pf[np].revents = 0;
			idx[np++] = i;
		}
		int ncon = np;
		pf[np].fd = d.sigr;
		pf[np].events = POLLIN;
		pf[np++].revents = 0;
		int lpos = -1, mpos = -1;
		if (d.lfd >= 0) {
			lpos = np;
			pf[np].fd = d.lfd;
			pf[np].events = POLLIN;
			pf[np++].revents = 0;
		}
		short mev = 0;
		if (!d.m_eof && (d.att < 0 || buf_pending(&d.c[d.att].out) < HIGH_WATER))
			mev |= POLLIN;
		if (!d.m_eof && buf_pending(&d.toshell))
			mev |= POLLOUT;
		if (mev) {
			mpos = np;
			pf[np].fd = d.mfd;
			pf[np].events = mev;
			pf[np++].revents = 0;
		}
		if (d.dying && d.die_deadline - now < timeout)
			timeout = d.die_deadline - now;
		if (d.winch_at && d.winch_at - now < timeout)
			timeout = d.winch_at - now;
		if (!d.dying && d.att < 0 && d.idle) {
			int64_t left = ((int64_t)d.last_detach + d.idle - (int64_t)wall) * 1000;
			if (left < timeout)
				timeout = left;
		}
		if (timeout < 0)
			timeout = 0;

		int r = poll(pf, (nfds_t)np, (int)timeout);
		if (r < 0 && errno != EINTR)
			_exit(EXIT_ERR);
		if (r <= 0)
			continue;
		now = mono_ms();
		if (pf[ncon].revents) {
			char junk[64];
			while (read(d.sigr, junk, sizeof junk) > 0)
				;
		}
		if (mpos >= 0 && pf[mpos].revents) {
			if (pf[mpos].revents & (POLLIN | POLLHUP | POLLERR))
				read_master(4);
			if ((pf[mpos].revents & POLLOUT) && buf_pending(&d.toshell)) {
				ssize_t w = write(d.mfd, d.toshell.p + d.toshell.off, buf_pending(&d.toshell));
				if (w > 0)
					buf_consume(&d.toshell, (size_t)w);
				else if (w < 0 && errno != EAGAIN && errno != EINTR)
					buf_consume(&d.toshell, buf_pending(&d.toshell));
			}
		}
		for (int k = 0; k < ncon; k++) {
			int i = idx[k];
			short rev = pf[k].revents;
			if (!rev || d.c[i].role == C_FREE)
				continue;
			if ((rev & POLLOUT) && buf_flush(d.c[i].fd, &d.c[i].out) < 0) {
				conn_close(i);
				continue;
			}
			if (rev & POLLOUT)
				d.c[i].progress = now;
			if (rev & (POLLIN | POLLHUP | POLLERR)) {
				if (d.c[i].role == C_PENDING || d.c[i].role == C_ATTACHED)
					read_conn(i, now);
				else if (rev & (POLLHUP | POLLERR))
					conn_close(i);
			}
		}
		if (lpos >= 0 && d.lfd >= 0 && pf[lpos].revents)
			accept_conns(now);
	}
}
