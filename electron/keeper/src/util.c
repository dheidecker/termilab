/* Buffers, framing and small I/O helpers shared by client and daemon. */
#include "keeper.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

int64_t mono_ms(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int set_nonblock(int fd, int on)
{
	int fl = fcntl(fd, F_GETFL);
	if (fl < 0)
		return -1;
	fl = on ? (fl | O_NONBLOCK) : (fl & ~O_NONBLOCK);
	return fcntl(fd, F_SETFL, fl);
}

void put16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v & 0xff; }
void put32(uint8_t *p, uint32_t v)
{
	p[0] = v >> 24; p[1] = (v >> 16) & 0xff; p[2] = (v >> 8) & 0xff; p[3] = v & 0xff;
}
uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] << 8 | p[1]); }
uint32_t get32(const uint8_t *p)
{
	return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}

size_t buf_pending(const struct buf *b) { return b->len - b->off; }

/* Appends n bytes; fails (and changes nothing) if the result would exceed b->max. */
int buf_append(struct buf *b, const void *d, size_t n)
{
	if (n == 0)
		return 0;
	if (n > b->max || buf_pending(b) > b->max - n)
		return -1;
	if (b->cap - b->len < n) {
		if (b->off) {
			memmove(b->p, b->p + b->off, b->len - b->off);
			b->len -= b->off;
			b->off = 0;
		}
		if (b->cap - b->len < n) {
			size_t need = b->len + n, nc = b->cap ? b->cap : 4096;
			while (nc < need)
				nc *= 2;
			if (nc > b->max)
				nc = b->max;
			uint8_t *np = realloc(b->p, nc);
			if (!np)
				return -1;
			b->p = np;
			b->cap = nc;
		}
	}
	memcpy(b->p + b->len, d, n);
	b->len += n;
	return 0;
}

void buf_consume(struct buf *b, size_t n)
{
	b->off += n;
	if (b->off >= b->len)
		b->off = b->len = 0;
}

void buf_free(struct buf *b)
{
	free(b->p);
	b->p = NULL;
	b->off = b->len = b->cap = 0;
}

int frame_put(struct buf *b, int type, const void *p, size_t n)
{
	uint8_t h[5];
	if (n > MAX_FRAME || buf_pending(b) + 5 + n > b->max)
		return -1;
	h[0] = (uint8_t)type;
	put32(h + 1, (uint32_t)n);
	if (buf_append(b, h, 5) < 0)
		return -1;
	if (buf_append(b, p, n) < 0) {
		b->len -= 5; /* undo header; cannot fail after the size check above */
		return -1;
	}
	return 0;
}

/* 1 = frame in *f (valid until the next append to b), 0 = need more, -1 = malformed. */
int frame_get(struct buf *b, struct frame *f)
{
	size_t have = buf_pending(b);
	if (have < 5)
		return 0;
	const uint8_t *h = b->p + b->off;
	uint32_t len = get32(h + 1);
	if (h[0] == 0 || h[0] > F_MAXTYPE || len > MAX_FRAME)
		return -1;
	if (have - 5 < len)
		return 0;
	f->type = h[0];
	f->len = len;
	f->p = h + 5;
	buf_consume(b, 5 + (size_t)len);
	return 1;
}

int buf_flush(int fd, struct buf *b)
{
	while (buf_pending(b)) {
		ssize_t w = send(fd, b->p + b->off, buf_pending(b), MSG_NOSIGNAL);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK)
				return 0;
			return -1;
		}
		buf_consume(b, (size_t)w);
	}
	return 0;
}

int write_full(int fd, const void *p, size_t n)
{
	const uint8_t *c = p;
	while (n) {
		ssize_t w = write(fd, c, n);
		if (w < 0) {
			if (errno == EINTR)
				continue;
			if (errno == EAGAIN || errno == EWOULDBLOCK) {
				struct pollfd pf = { fd, POLLOUT, 0 };
				if (poll(&pf, 1, -1) < 0 && errno != EINTR)
					return -1;
				continue;
			}
			return -1;
		}
		c += w;
		n -= (size_t)w;
	}
	return 0;
}

/* Blocking-with-timeout read of one frame: 1 ok, 0 EOF/timeout, -1 error. */
int recv_frame(int fd, struct buf *in, struct frame *f, int timeout_ms)
{
	int64_t end = mono_ms() + timeout_ms;
	uint8_t tmp[4096];
	for (;;) {
		int r = frame_get(in, f);
		if (r != 0)
			return r;
		int64_t left = end - mono_ms();
		if (left <= 0)
			return 0;
		struct pollfd pf = { fd, POLLIN, 0 };
		r = poll(&pf, 1, (int)left);
		if (r < 0 && errno != EINTR)
			return -1;
		if (r <= 0)
			continue;
		ssize_t n = read(fd, tmp, sizeof tmp);
		if (n < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		if (n <= 0)
			return n < 0 ? -1 : 0;
		if (buf_append(in, tmp, (size_t)n) < 0)
			return -1;
	}
}

/* JSON string body (no quotes). Control and non-ASCII bytes become \u00XX or '?'. */
void json_str(char *out, size_t cap, const char *s)
{
	size_t n = 0;
	if (cap == 0)
		return;
	for (; *s && n + 7 < cap; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') {
			out[n++] = '\\';
			out[n++] = (char)c;
		} else if (c < 0x20) {
			n += (size_t)snprintf(out + n, cap - n, "\\u%04x", c);
		} else {
			out[n++] = c < 0x7f ? (char)c : '?';
		}
	}
	out[n] = 0;
}
