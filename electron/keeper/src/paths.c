/* Where sessions live, and the ownership checks that make that place safe. */
#include "keeper.h"

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

int valid_id(const char *id)
{
	size_t n = 0;
	for (; id[n]; n++)
		if (n >= 40 || !((id[n] >= 'a' && id[n] <= 'z') || (id[n] >= '0' && id[n] <= '9')))
			return 0;
	return n >= 8;
}

/* 0 ok, 1 missing (and !create), -1 refused or failed (message printed). */
static int check_dir(const char *path, int create, int strict)
{
	struct stat st;
	if (lstat(path, &st) < 0) {
		if (errno != ENOENT) {
			fprintf(stderr, "termilab-keeper: %s: %s\n", path, strerror(errno));
			return -1;
		}
		if (!create)
			return 1;
		if (mkdir(path, 0700) < 0 && errno != EEXIST) {
			fprintf(stderr, "termilab-keeper: mkdir %s: %s\n", path, strerror(errno));
			return -1;
		}
		if (lstat(path, &st) < 0) {
			fprintf(stderr, "termilab-keeper: %s: %s\n", path, strerror(errno));
			return -1;
		}
	}
	const char *why = NULL;
	if (!S_ISDIR(st.st_mode))
		why = "is not a directory (symlinks are refused)";
	else if (st.st_uid != getuid())
		why = "is not owned by you";
	else if (st.st_mode & 022)
		why = "is group- or world-writable";
	if (why) {
		fprintf(stderr, "termilab-keeper: refusing %s: %s\n", path, why);
		return -1;
	}
	if (strict && (st.st_mode & 077) && chmod(path, 0700) < 0) {
		fprintf(stderr, "termilab-keeper: chmod %s: %s\n", path, strerror(errno));
		return -1;
	}
	return 0;
}

int paths_init(struct paths *p, int create)
{
	char base[4096], run[4096];
	const char *home = getenv("HOME");
	if (!home || home[0] != '/') {
		struct passwd *pw = getpwuid(getuid());
		home = pw && pw->pw_dir && pw->pw_dir[0] == '/' ? pw->pw_dir : NULL;
	}
	int n = home ? snprintf(base, sizeof base, "%s/.termilab", home) : -1;
	if (n > 0 && (size_t)n < sizeof base)
		n = snprintf(run, sizeof run, "%s/run", base);
	if (n > 0 && n <= DIR_MAX) {
		int r = check_dir(base, create, 0);
		if (r == 0)
			r = check_dir(run, create, 1);
		if (r == 0)
			memcpy(p->dir, run, (size_t)n + 1);
		return r;
	}
	/* $HOME too long for a unix socket path: per-user dir in /tmp. */
	n = snprintf(p->dir, sizeof p->dir, "/tmp/termilab-%u", (unsigned)getuid());
	if (n < 0 || n > DIR_MAX)
		return -1;
	return check_dir(p->dir, create, 1);
}

int sess_path(const struct paths *p, const char *id, const char *sfx, char *out, size_t cap)
{
	int n = snprintf(out, cap, "%s/%s%s", p->dir, id, sfx);
	return n > 0 && (size_t)n < cap ? 0 : -1;
}

/* Serialises session creation (and stale-socket cleanup) for this user. */
int lock_run(const struct paths *p)
{
	char path[DIR_MAX + 16];
	snprintf(path, sizeof path, "%s/.lock", p->dir);
	int fd = open(path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
	if (fd < 0) {
		fprintf(stderr, "termilab-keeper: %s: %s\n", path, strerror(errno));
		return -1;
	}
	while (flock(fd, LOCK_EX) < 0) {
		if (errno != EINTR) {
			close(fd);
			return -1;
		}
	}
	return fd;
}

/* Connects and verifies the daemon runs as us. -1 with errno on failure. */
int connect_sock(const char *path)
{
	struct sockaddr_un sa;
	size_t len = strlen(path);
	if (len >= sizeof sa.sun_path) {
		errno = ENAMETOOLONG;
		return -1;
	}
	memset(&sa, 0, sizeof sa);
	sa.sun_family = AF_UNIX;
	memcpy(sa.sun_path, path, len + 1);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;
	int r;
	do
		r = connect(fd, (struct sockaddr *)&sa, sizeof sa);
	while (r < 0 && errno == EINTR);
	if (r < 0) {
		int e = errno;
		close(fd);
		errno = e;
		return -1;
	}
	struct ucred cr;
	socklen_t cl = sizeof cr;
	if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cr, &cl) < 0 || cr.uid != getuid()) {
		close(fd);
		errno = EPERM;
		return -1;
	}
	return fd;
}

void remove_stale(const char *path)
{
	struct stat st;
	if (lstat(path, &st) == 0 && S_ISSOCK(st.st_mode) && st.st_uid == getuid())
		unlink(path);
}
