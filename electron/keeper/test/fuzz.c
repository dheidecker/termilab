/* Random-input fuzzer for the parts that eat untrusted bytes: the frame
 * decoder and the escape scanner (+ ring, replay boundary, restore).
 * Build with -fsanitize=address,undefined; run: ./fuzz <seconds> [seed]. */
#include "../src/keeper.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint64_t rs = 88172645463325252ull;
static uint32_t rnd(void)
{
	rs ^= rs << 13;
	rs ^= rs >> 7;
	rs ^= rs << 17;
	return (uint32_t)(rs >> 11);
}

#define FAIL(...) do { fprintf(stderr, "FUZZ FAIL: " __VA_ARGS__); fputc('\n', stderr); abort(); } while (0)

static const char ALPHA[] = "\033\033\033\033[[[]]?;;;:0123456789mhlrpc=>78!P\\\a\x18\x1a\n\r ab\xc3\xa9\xe2\x82\xac\x80\xff";

static size_t gen_term(uint8_t *p, size_t max)
{
	static const char *seq[] = { "\033[?1049h", "\033[?1049l", "\033[?47h", "\033[?1h", "\033=",
		"\033[?2004h", "\033[?1000h", "\033[?1006h", "\033[?25l", "\033[38;2;1;2;3m",
		"\033[48:5:200m", "\033[4:3m", "\033[1;31m", "\033]2;title\a", "\033]0;\xc3\xa9t\xc3\033\\",
		"\033[3;20r", "\033[!p", "\033c", "\033P1$q\033\\", "\033[0m", "\033[58;5;9m", "\033[?1003h" };
	size_t n = 1 + rnd() % max, i = 0;
	while (i < n) {
		uint32_t k = rnd() % 10;
		if (k < 3) {
			const char *s = seq[rnd() % (sizeof seq / sizeof seq[0])];
			for (; *s && i < n; s++)
				p[i++] = (uint8_t)*s;
		} else if (k < 8) {
			p[i++] = (uint8_t)ALPHA[rnd() % (sizeof ALPHA - 1)];
		} else {
			p[i++] = (uint8_t)rnd();
		}
	}
	return n;
}

static void fuzz_frames(void)
{
	struct buf b = { .max = IN_MAX }, o = { .max = OUT_MAX };
	uint8_t tmp[4096];
	struct frame f;
	/* 1: garbage never crashes, never yields an oversized frame */
	for (int round = 0; round < 50; round++) {
		size_t n = rnd() % sizeof tmp;
		for (size_t i = 0; i < n; i++)
			tmp[i] = (uint8_t)rnd();
		if (rnd() % 2 && n >= 5) { /* plausible header */
			tmp[0] = (uint8_t)(1 + rnd() % (F_MAXTYPE + 1));
			put32(tmp + 1, rnd() % 3 ? rnd() % 64 : rnd());
		}
		if (buf_append(&b, tmp, n) < 0) {
			buf_free(&b);
			continue;
		}
		int r;
		while ((r = frame_get(&b, &f)) == 1)
			if (f.len > MAX_FRAME || f.type < 1 || f.type > F_MAXTYPE)
				FAIL("bad frame accepted");
		if (r < 0)
			buf_free(&b), b.off = b.len = 0;
	}
	/* 2: round trip of well-formed frames split at random points */
	buf_free(&b);
	uint8_t pay[256];
	int types[64];
	size_t lens[64];
	int nf = 1 + rnd() % 64;
	for (int i = 0; i < nf; i++) {
		types[i] = 1 + (int)(rnd() % F_MAXTYPE);
		lens[i] = rnd() % sizeof pay;
		memset(pay, i, lens[i]);
		if (frame_put(&o, types[i], pay, lens[i]) < 0)
			FAIL("frame_put");
	}
	int got = 0;
	while (buf_pending(&o)) {
		size_t k = 1 + rnd() % 300;
		if (k > buf_pending(&o))
			k = buf_pending(&o);
		if (buf_append(&b, o.p + o.off, k) < 0)
			FAIL("append");
		buf_consume(&o, k);
		while (frame_get(&b, &f) == 1) {
			if (got >= nf || f.type != types[got] || f.len != lens[got])
				FAIL("round trip mismatch");
			for (uint32_t j = 0; j < f.len; j++)
				if (f.p[j] != (uint8_t)got)
					FAIL("payload mismatch");
			got++;
		}
	}
	if (got != nf)
		FAIL("lost frames");
	buf_free(&b);
	buf_free(&o);
}

static struct ring ring;
static struct scan head, tail, snap;
static int snap_valid;
static uint64_t snap_off;
static uint8_t *shadow; /* every byte written since the last ring reset */
static size_t shadow_len;
static uint64_t max_head, wraps;
#define SHADOW_MAX (3u * RING_SIZE)

static void check_replay(void)
{
	struct scan base, fresh;
	uint64_t start, rst = ring_start(&ring);
	char pre[1100];
	if (head.alt && snap_valid && snap_off >= rst) {
		base = snap;
		start = snap_off;
	} else {
		base = tail;
		start = rst;
		uint64_t lim = rst + IO_CHUNK;
		while (start < ring.head) {
			uint8_t b;
			ring_copy(&ring, start, &b, 1);
			if ((scan_ground(&base) || start >= lim) && (b & 0xc0) != 0x80)
				break;
			scan_feed(&base, &b, 1);
			start++;
		}
	}
	pre[0] = 033;
	pre[1] = 'c';
	size_t n = scan_restore(&base, pre + 2, sizeof pre - 2);
	if (n >= 1000)
		FAIL("restore too long: %zu", n);
	scan_init(&fresh);
	size_t off = 0;
	while (off < n + 2)
		off += scan_feed(&fresh, (uint8_t *)pre + off, n + 2 - off);
	if (!scan_ground(&fresh) || !scan_same(&base, &fresh))
		FAIL("restore round trip differs");
	/* replaying [start, head) after the restore must end in head's state
	 * (DECSC's saved attributes are not restored, so carry them over) */
	int exact = scan_ground(&base);
	fresh.saved_sgr = base.saved_sgr;
	static uint8_t chunk[IO_CHUNK];
	while (start < ring.head) {
		size_t k = ring_copy(&ring, start, chunk, sizeof chunk);
		if (memcmp(chunk, shadow + (shadow_len - (size_t)(ring.head - start)), k))
			FAIL("ring content differs from shadow");
		for (size_t o2 = 0; o2 < k;)
			o2 += scan_feed(&fresh, chunk + o2, k - o2);
		start += k;
	}
	if (exact && !scan_same(&fresh, &head))
		FAIL("replayed state differs from live state");
}

static void fuzz_scanner(void)
{
	static uint8_t data[200000];
	size_t n = gen_term(data, rnd() % 8 ? 2000 : sizeof data);
	if (shadow_len + n > SHADOW_MAX || rnd() % 500 == 0) {
		if (ring.head > RING_SIZE)
			wraps++;
		ring.head = 0;
		shadow_len = 0;
		scan_init(&head);
		scan_init(&tail);
		snap_valid = 0;
	}
	uint64_t base = ring.head;
	ring_write(&ring, &tail, data, n);
	if (ring.head > max_head)
		max_head = ring.head;
	memcpy(shadow + shadow_len, data, n);
	shadow_len += n;
	for (size_t off = 0; off < n;) {
		off += scan_feed(&head, data + off, n - off);
		if (head.ev_alt) {
			snap = head;
			snap_valid = 1;
			snap_off = base + off;
		}
	}
	if (rnd() % 8 == 0)
		check_replay();
}

int main(int argc, char **argv)
{
	int secs = argc > 1 ? atoi(argv[1]) : 10;
	if (argc > 2)
		rs = strtoull(argv[2], NULL, 10) | 1;
	ring.p = malloc(RING_SIZE);
	shadow = malloc(SHADOW_MAX);
	if (!ring.p || !shadow)
		return 1;
	scan_init(&head);
	scan_init(&tail);
	time_t end = time(NULL) + secs;
	unsigned long iters = 0;
	while (time(NULL) < end) {
		for (int i = 0; i < 200; i++, iters++) {
			fuzz_frames();
			fuzz_scanner();
		}
	}
	char id[64];
	for (int i = 0; i < 100000; i++) { /* id validator and JSON escaper */
		size_t n = rnd() % 50;
		for (size_t j = 0; j < n; j++)
			id[j] = (char)(1 + rnd() % 255);
		id[n] = 0;
		char out[64];
		json_str(out, sizeof out, id);
		if (valid_id(id) && (n < 8 || n > 40))
			FAIL("valid_id length");
	}
	free(ring.p);
	free(shadow);
	printf("fuzz ok: %lu iterations, max ring head %llu bytes, %llu ring generations wrapped\n", iters,
	       (unsigned long long)max_head, (unsigned long long)wraps);
	return 0;
}
