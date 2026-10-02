/* Raw output ring. Offsets are absolute (bytes ever written); the live window
 * is [ring_start, head). Bytes that fall out of the window are fed to the
 * "tail" scanner, so it always holds the terminal state at ring_start. */
#include "keeper.h"

#include <string.h>

uint64_t ring_start(const struct ring *r)
{
	return r->head > RING_SIZE ? r->head - RING_SIZE : 0;
}

static void feed_all(struct scan *s, const uint8_t *p, size_t n)
{
	while (n) {
		size_t k = scan_feed(s, p, n);
		p += k;
		n -= k;
	}
}

/* Feeds ring bytes [from, to) to s. */
static void feed_range(const struct ring *r, struct scan *s, uint64_t from, uint64_t to)
{
	while (from < to) {
		size_t pos = (size_t)(from % RING_SIZE);
		size_t k = RING_SIZE - pos;
		if ((uint64_t)k > to - from)
			k = (size_t)(to - from);
		feed_all(s, r->p + pos, k);
		from += k;
	}
}

void ring_write(struct ring *r, struct scan *tail, const uint8_t *d, size_t n)
{
	uint64_t oldstart = ring_start(r), newhead = r->head + n;
	uint64_t newstart = newhead > RING_SIZE ? newhead - RING_SIZE : 0;
	size_t skip = 0;
	if (newstart > oldstart) {
		feed_range(r, tail, oldstart, newstart < r->head ? newstart : r->head);
		if (newstart > r->head) {
			skip = (size_t)(newstart - r->head);
			feed_all(tail, d, skip);
		}
	}
	uint64_t at = r->head + skip;
	for (size_t i = skip; i < n;) {
		size_t pos = (size_t)(at % RING_SIZE);
		size_t k = RING_SIZE - pos;
		if (k > n - i)
			k = n - i;
		memcpy(r->p + pos, d + i, k);
		i += k;
		at += k;
	}
	r->head = newhead;
}

size_t ring_copy(const struct ring *r, uint64_t from, uint8_t *out, size_t n)
{
	size_t got = 0;
	if (from < ring_start(r))
		from = ring_start(r);
	while (got < n && from < r->head) {
		size_t pos = (size_t)(from % RING_SIZE);
		size_t k = RING_SIZE - pos;
		if (k > n - got)
			k = n - got;
		if ((uint64_t)k > r->head - from)
			k = (size_t)(r->head - from);
		memcpy(out + got, r->p + pos, k);
		got += k;
		from += k;
	}
	return got;
}
