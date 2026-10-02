/* Command line: version | attach | list | kill. The attach client bridges its
 * tty to the session daemon, creating the daemon first if asked to. */
#include "keeper.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define MAXLIST 64

struct sinfo { char id[48]; char json[1024]; long long last; int attached; };

static int g_tty, g_sigw = -1;
static struct termios g_orig;

static void restore_tty(void)
{
	if (g_tty) {
		tcsetattr(0, TCSAFLUSH, &g_orig);
		g_tty = 0;
	}
}

static void quit(int code, const char *msg) __attribute__((noreturn));
static void quit(int code, const char *msg)
{
	restore_tty();
	if (msg)
		fprintf(stderr, "\r\n[termilab-keeper: %s]\r\n", msg);
	exit(code);
}

static void usage(void) __attribute__((noreturn));
static void usage(void)
{
	fprintf(stderr,
	        "usage: termilab-keeper version\n"
	        "       termilab-keeper attach <id> [--cols C --rows R] [--create]\n"
	        "                              [--idle-days N | --idle-seconds N]\n"
	        "       termilab-keeper list\n"
	        "       termilab-keeper kill <id>\n");
	exit(EXIT_ERR);
}

static int parse_num(const char *s, unsigned long max, unsigned long *out)
{
	char *e;
	if (!s || !*s || *s == '-')
		return -1;
	errno = 0;
	unsigned long v = strtoul(s, &e, 10);
	if (errno || *e || v > max)
		return -1;
	*out = v;
	return 0;
}

static void on_sig(int sig)
{
	int e = errno;
	char b = (char)sig;
	if (g_sigw >= 0)
		(void)!write(g_sigw, &b, 1);
	errno = e;
}

static const char *json_find(const char *j, const char *key)
{
	const char *p = strstr(j, key);
	return p ? p + strlen(key) : NULL;
}

static int query_info(int fd, char *json, size_t cap)
{
	struct buf in = { .max = 4096 };
	struct frame f;
	uint8_t h[5] = { F_LIST, 0, 0, 0, 0 };
	int ok = -1;
	if (write_full(fd, h, sizeof h) == 0 && recv_frame(fd, &in, &f, 2000) == 1 &&
	    f.type == F_INFO && f.len < cap) {
		memcpy(json, f.p, f.len);
		json[f.len] = 0;
		ok = 0;
	}
	buf_free(&in);
	return ok;
}

/* Live sessions in the run dir; stale sockets are removed (caller holds the lock). */
static int collect(const struct paths *P, struct sinfo *out, int max)
{
	DIR *dir = opendir(P->dir);
	struct dirent *e;
	int n = 0;
	if (!dir)
		return 0;
	while ((e = readdir(dir))) {
		char id[48], path[SUN_MAX];
		size_t len = strlen(e->d_name);
		if (len < 6 || len - 5 >= sizeof id || strcmp(e->d_name + len - 5, ".sock"))
			continue;
		memcpy(id, e->d_name, len - 5);
		id[len - 5] = 0;
		if (!valid_id(id) || sess_path(P, id, ".sock", path, sizeof path) < 0)
			continue;
		int fd = connect_sock(path);
		if (fd < 0) {
			if (errno == ECONNREFUSED)
				remove_stale(path);
			continue;
		}
		struct sinfo tmp, *s = n < max ? &out[n] : &tmp;
		if (query_info(fd, s->json, sizeof s->json) == 0) {
			const char *v = json_find(s->json, "\"lastAttach\":");
			snprintf(s->id, sizeof s->id, "%s", id);
			s->last = v ? atoll(v) : 0;
			s->attached = json_find(s->json, "\"attached\":true") != NULL;
			n++;
		}
		close(fd);
	}
	closedir(dir);
	return n;
}

static void check_cap(const struct paths *P)
{
	static struct sinfo s[MAXLIST];
	int n = collect(P, s, MAXLIST);
	if (n < MAX_SESSIONS)
		return;
	if (n > MAXLIST)
		n = MAXLIST;
	fprintf(stderr, "termilab-keeper: session limit reached (%d). Oldest detached:", MAX_SESSIONS);
	for (int k = 0, shown = 0; k < 5 && shown < n; k++) {
		int best = -1;
		for (int i = 0; i < n; i++)
			if (!s[i].attached && s[i].id[0] && (best < 0 || s[i].last < s[best].last))
				best = i;
		if (best < 0)
			break;
		char when[32];
		time_t t = (time_t)s[best].last;
		struct tm tm;
		strftime(when, sizeof when, "%Y-%m-%dT%H:%M:%SZ", gmtime_r(&t, &tm));
		fprintf(stderr, " %s (last attach %s)", s[best].id, when);
		s[best].id[0] = 0;
		shown++;
	}
	fprintf(stderr, "\n");
	exit(EXIT_CAP);
}

static void spawn_daemon(const struct paths *P, const char *id, unsigned cols, unsigned rows,
                         uint32_t idle)
{
	int pfd[2];
	fflush(NULL);
	if (pipe2(pfd, O_CLOEXEC) < 0)
		quit(EXIT_ERR, "pipe failed");
	pid_t pid = fork();
	if (pid < 0)
		quit(EXIT_ERR, "fork failed");
	if (pid == 0) {
		close(pfd[0]);
		if (setsid() < 0)
			_exit(1);
		pid_t p2 = fork();
		if (p2 != 0)
			_exit(p2 < 0);
		daemon_main(P, id, (uint16_t)cols, (uint16_t)rows, idle, pfd[1]);
	}
	close(pfd[1]);
	while (waitpid(pid, NULL, 0) < 0 && errno == EINTR)
		;
	char msg[512];
	size_t n = 0;
	int64_t end = mono_ms() + 10000;
	while (n < sizeof msg - 1) {
		struct pollfd pf = { pfd[0], POLLIN, 0 };
		int64_t left = end - mono_ms();
		if (left <= 0 || (poll(&pf, 1, (int)left) < 0 && errno != EINTR))
			break;
		ssize_t r = read(pfd[0], msg + n, sizeof msg - 1 - n);
		if (r < 0 && errno == EINTR)
			continue;
		if (r <= 0)
			break;
		n += (size_t)r;
	}
	close(pfd[0]);
	msg[n] = 0;
	if (n >= 2 && !memcmp(msg, "OK", 2))
		return;
	fprintf(stderr, "termilab-keeper: could not start session: %s\n",
	        n > 1 ? msg + 1 : "daemon did not report");
	exit(EXIT_ERR);
}

/* Points <id>.agent at this client's agent socket, so the session's
 * SSH_AUTH_SOCK follows whichever connection attached last. */
static void update_agent(const struct paths *P, const char *id)
{
	char link[SUN_MAX], tmp[SUN_MAX + 32];
	const char *a = getenv("SSH_AUTH_SOCK");
	if (sess_path(P, id, ".agent", link, sizeof link) < 0)
		return;
	if (!a || !*a) {
		unlink(link);
		return;
	}
	if (!strcmp(a, link))
		return; /* attaching from inside the same session */
	snprintf(tmp, sizeof tmp, "%s.%d.l", link, (int)getpid());
	unlink(tmp);
	if (symlink(a, tmp) == 0 && rename(tmp, link) != 0)
		unlink(tmp);
}

static int get_winsize(unsigned *cols, unsigned *rows)
{
	struct winsize ws;
	if (ioctl(0, TIOCGWINSZ, &ws) < 0 || !ws.ws_col || !ws.ws_row)
		return -1;
	*cols = ws.ws_col;
	*rows = ws.ws_row;
	return 0;
}

static void run_client(const struct paths *P, const char *id, int fd, unsigned cols,
                       unsigned rows, int idle_set, uint32_t idle)
{
	struct buf in = { .max = IN_MAX }, out = { .max = OUT_MAX };
	uint8_t hello[12], tmp[IO_CHUNK];
	struct frame f;
	int sp[2], acked = 0, stdin_eof = 0;
	int64_t ack_deadline = mono_ms() + 10000;

	put16(hello, KEEPER_PROTO);
	put16(hello + 2, (uint16_t)cols);
	put16(hello + 4, (uint16_t)rows);
	put16(hello + 6, idle_set ? 1 : 0);
	put32(hello + 8, idle);
	if (set_nonblock(fd, 1) < 0 || frame_put(&out, F_HELLO, hello, sizeof hello) < 0 ||
	    pipe2(sp, O_CLOEXEC | O_NONBLOCK) < 0)
		quit(EXIT_ERR, "setup failed");
	g_sigw = sp[1];
	struct sigaction sa;
	memset(&sa, 0, sizeof sa);
	sigemptyset(&sa.sa_mask);
	sa.sa_handler = SIG_IGN;
	sigaction(SIGPIPE, &sa, NULL);
	sa.sa_handler = on_sig;
	sa.sa_flags = SA_RESTART;
	int sigs[] = { SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGQUIT };
	for (size_t i = 0; i < sizeof sigs / sizeof sigs[0]; i++)
		sigaction(sigs[i], &sa, NULL);

	if (isatty(0) && tcgetattr(0, &g_orig) == 0) {
		struct termios raw = g_orig;
		cfmakeraw(&raw);
		if (tcsetattr(0, TCSANOW, &raw) == 0)
			g_tty = 1;
	}
	atexit(restore_tty);

	for (;;) {
		struct pollfd pf[3] = {
			{ fd, (short)(POLLIN | (buf_pending(&out) ? POLLOUT : 0)), 0 },
			{ 0, (short)(!stdin_eof && buf_pending(&out) < HIGH_WATER ? POLLIN : 0), 0 },
			{ sp[0], POLLIN, 0 },
		};
		int timeout = -1;
		if (!acked) {
			int64_t left = ack_deadline - mono_ms();
			timeout = left > 0 ? (int)left : 0;
		}
		int r = poll(pf, 3, timeout);
		if (r < 0 && errno != EINTR)
			quit(EXIT_ERR, "poll failed");
		if (r == 0 && !acked)
			quit(EXIT_ERR, "session did not answer");
		if (r <= 0)
			continue;
		if (pf[2].revents) {
			char sg[32];
			ssize_t k;
			while ((k = read(sp[0], sg, sizeof sg)) > 0)
				for (ssize_t j = 0; j < k; j++) {
					unsigned c2, r2;
					if (sg[j] == SIGWINCH) {
						uint8_t rs[4];
						if (get_winsize(&c2, &r2) == 0) {
							put16(rs, (uint16_t)c2);
							put16(rs + 2, (uint16_t)r2);
							frame_put(&out, F_RESIZE, rs, 4);
						}
					} else {
						frame_put(&out, F_DETACH, NULL, 0);
						set_nonblock(fd, 0);
						buf_flush(fd, &out);
						quit(EXIT_GONE, NULL);
					}
				}
		}
		if (pf[1].revents) {
			ssize_t n = read(0, tmp, sizeof tmp);
			if (n > 0) {
				if (frame_put(&out, F_DATA, tmp, (size_t)n) < 0)
					quit(EXIT_ERR, "output queue full");
			} else if (n == 0 || (errno != EINTR && errno != EAGAIN)) {
				stdin_eof = 1;
				frame_put(&out, F_DETACH, NULL, 0);
				set_nonblock(fd, 0);
				buf_flush(fd, &out);
				quit(EXIT_GONE, NULL);
			}
		}
		if (pf[0].revents & POLLOUT) {
			if (buf_flush(fd, &out) < 0)
				quit(EXIT_ERR, "connection to session lost");
		}
		if (pf[0].revents & (POLLIN | POLLHUP | POLLERR)) {
			ssize_t n = read(fd, tmp, sizeof tmp);
			if (n < 0 && (errno == EINTR || errno == EAGAIN))
				continue;
			if (n <= 0)
				quit(EXIT_ERR, "connection to session lost");
			if (buf_append(&in, tmp, (size_t)n) < 0)
				quit(EXIT_ERR, "protocol error");
			while ((r = frame_get(&in, &f)) == 1) {
				switch (f.type) {
				case F_HELLO:
					if (!acked) {
						acked = 1;
						update_agent(P, id);
					}
					break;
				case F_DATA:
					if (write_full(1, f.p, f.len) < 0)
						quit(EXIT_GONE, NULL);
					break;
				case F_DETACHED:
					if (f.len >= 1 && f.p[0] == R_REPLACED)
						quit(EXIT_REPLACED, "attached from another connection");
					quit(EXIT_KILLED, f.len >= 1 && f.p[0] == R_EXPIRED ? "session expired"
					                                                   : "session killed");
				case F_EXIT:
					quit(EXIT_OK, NULL);
				case F_ERROR: {
					char m[200];
					snprintf(m, sizeof m, "%.*s", (int)(f.len < 150 ? f.len : 150), f.p);
					quit(EXIT_PROTO, m);
				}
				default:
					break;
				}
			}
			if (r < 0)
				quit(EXIT_ERR, "protocol error");
		}
	}
}

static int cmd_attach(int argc, char **argv)
{
	const char *id = NULL;
	unsigned long cols = 0, rows = 0, v;
	int create = 0, idle_set = 0;
	uint32_t idle = DEFAULT_IDLE;
	for (int i = 0; i < argc; i++) {
		const char *a = argv[i], *nx = i + 1 < argc ? argv[i + 1] : NULL;
		if (!strcmp(a, "--create")) {
			create = 1;
		} else if (!strcmp(a, "--cols") || !strcmp(a, "--rows")) {
			if (parse_num(nx, 10000, &v) < 0 || v == 0)
				usage();
			*(a[2] == 'c' ? &cols : &rows) = v;
			i++;
		} else if (!strcmp(a, "--idle-days")) {
			if (parse_num(nx, 3650, &v) < 0)
				usage();
			idle = (uint32_t)(v * 86400);
			idle_set = 1;
			i++;
		} else if (!strcmp(a, "--idle-seconds")) {
			if (parse_num(nx, 3650ul * 86400, &v) < 0)
				usage();
			idle = (uint32_t)v;
			idle_set = 1;
			i++;
		} else if (!id && a[0] != '-') {
			id = a;
		} else {
			usage();
		}
	}
	if (!id || !valid_id(id)) {
		fprintf(stderr, "termilab-keeper: invalid session id (want [a-z0-9]{8,40})\n");
		return EXIT_ERR;
	}
	if (!cols || !rows) {
		unsigned c2 = 80, r2 = 24;
		get_winsize(&c2, &r2);
		if (!cols)
			cols = c2;
		if (!rows)
			rows = r2;
	}
	struct paths P;
	int pr = paths_init(&P, create);
	if (pr < 0)
		return EXIT_ERR;
	char sock[SUN_MAX];
	if (pr == 1 || sess_path(&P, id, ".sock", sock, sizeof sock) < 0) {
		fprintf(stderr, "termilab-keeper: no session %s\n", id);
		return EXIT_NOSESSION;
	}
	int fd = connect_sock(sock);
	if (fd < 0 && errno != ENOENT && errno != ECONNREFUSED) {
		fprintf(stderr, "termilab-keeper: %s: %s\n", sock, strerror(errno));
		return EXIT_ERR;
	}
	if (fd < 0) {
		if (!create) {
			fprintf(stderr, "termilab-keeper: no session %s\n", id);
			return EXIT_NOSESSION;
		}
		int lk = lock_run(&P);
		if (lk < 0)
			return EXIT_ERR;
		fd = connect_sock(sock);
		if (fd < 0) {
			if (errno == ECONNREFUSED)
				remove_stale(sock);
			check_cap(&P);
			spawn_daemon(&P, id, (unsigned)cols, (unsigned)rows, idle);
			fd = connect_sock(sock);
		}
		close(lk);
		if (fd < 0) {
			fprintf(stderr, "termilab-keeper: cannot reach new session: %s\n", strerror(errno));
			return EXIT_ERR;
		}
	}
	run_client(&P, id, fd, (unsigned)cols, (unsigned)rows, idle_set, idle);
	return EXIT_ERR;
}

static int cmd_list(void)
{
	static struct sinfo s[MAXLIST];
	struct paths P;
	int pr = paths_init(&P, 0);
	if (pr != 0)
		return pr == 1 ? 0 : EXIT_ERR;
	int lk = lock_run(&P);
	if (lk < 0)
		return EXIT_ERR;
	int n = collect(&P, s, MAXLIST);
	close(lk);
	for (int i = 0; i < n && i < MAXLIST; i++)
		printf("%s\n", s[i].json);
	return 0;
}

static int cmd_kill(const char *id)
{
	struct paths P;
	char sock[SUN_MAX];
	if (!id || !valid_id(id)) {
		fprintf(stderr, "termilab-keeper: invalid session id\n");
		return EXIT_ERR;
	}
	int pr = paths_init(&P, 0);
	if (pr < 0)
		return EXIT_ERR;
	int fd = pr == 0 && sess_path(&P, id, ".sock", sock, sizeof sock) == 0 ? connect_sock(sock) : -1;
	if (fd < 0) {
		fprintf(stderr, "termilab-keeper: no session %s\n", id);
		return EXIT_NOSESSION;
	}
	uint8_t h[5] = { F_KILL, 0, 0, 0, 0 };
	struct buf in = { .max = 4096 };
	struct frame f;
	if (write_full(fd, h, sizeof h) < 0)
		return EXIT_ERR;
	while (recv_frame(fd, &in, &f, 10000) == 1 && f.type != F_OK)
		;
	buf_free(&in);
	close(fd);
	return 0;
}

int main(int argc, char **argv)
{
	/* Never let a pipe or socket land on fd 0-2. */
	int nfd;
	while ((nfd = open("/dev/null", O_RDWR)) >= 0 && nfd <= 2)
		;
	if (nfd > 2)
		close(nfd);
	if (argc < 2)
		usage();
	if (!strcmp(argv[1], "version")) {
		printf("{\"keeperVersion\":%d,\"proto\":%d}\n", KEEPER_VERSION, KEEPER_PROTO);
		return 0;
	}
	if (!strcmp(argv[1], "attach"))
		return cmd_attach(argc - 2, argv + 2);
	if (!strcmp(argv[1], "list") && argc == 2)
		return cmd_list();
	if (!strcmp(argv[1], "kill") && argc == 3)
		return cmd_kill(argv[2]);
	usage();
}
