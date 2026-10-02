/* termilab-keeper: keeps a shell alive on a server across SSH disconnects.
 * One daemon per session (dtach model). See ../README.md for the protocol. */
#ifndef KEEPER_H
#define KEEPER_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define KEEPER_VERSION 1 /* KV: bump on any behaviour change */
#define KEEPER_PROTO 1

#define MAX_FRAME (1u << 20)      /* payload cap, both directions */
#define RING_SIZE (4u << 20)      /* replay buffer */
#define MAX_SESSIONS 20           /* per user, checked at create */
#define DEFAULT_IDLE (14u * 86400) /* seconds without a client */
#define IO_CHUNK 65536
#define IN_MAX (MAX_FRAME + 5 + IO_CHUNK)
#define OUT_MAX (8u << 20)
#define HIGH_WATER (256u << 10)
#define SUN_MAX 108
#define DIR_MAX 50 /* run dir length that leaves room for <id>.<pid>.tmp */

enum { EXIT_OK = 0, EXIT_REPLACED = 75, EXIT_KILLED = 76, EXIT_GONE = 77,
       EXIT_ERR = 101, EXIT_NOSESSION = 102, EXIT_CAP = 103, EXIT_PROTO = 104 };

enum { F_HELLO = 1, F_DATA, F_RESIZE, F_DETACH, F_DETACHED, F_EXIT, F_KILL,
       F_LIST, F_INFO, F_OK, F_ERROR, F_MAXTYPE = F_ERROR };

enum { R_REPLACED = 1, R_KILLED = 2, R_EXPIRED = 3 };

/* ---- util.c ---- */
struct buf { uint8_t *p; size_t off, len, cap, max; };
struct frame { int type; uint32_t len; const uint8_t *p; };

int64_t mono_ms(void);
int set_nonblock(int fd, int on);
size_t buf_pending(const struct buf *b);
int buf_append(struct buf *b, const void *d, size_t n);
void buf_consume(struct buf *b, size_t n);
void buf_free(struct buf *b);
int frame_put(struct buf *b, int type, const void *p, size_t n);
int frame_get(struct buf *b, struct frame *f);
int buf_flush(int fd, struct buf *b); /* nonblocking; -1 on fatal error */
int write_full(int fd, const void *p, size_t n);
int recv_frame(int fd, struct buf *in, struct frame *f, int timeout_ms);
void put16(uint8_t *p, uint16_t v);
void put32(uint8_t *p, uint32_t v);
uint16_t get16(const uint8_t *p);
uint32_t get32(const uint8_t *p);
void json_str(char *out, size_t cap, const char *s);

/* ---- scan.c: escape-sequence scanner (tracks modes, never renders) ---- */
#define NPARAM 32
#define TITLE_MAX 256
struct sgr { uint16_t flags; uint8_t ul; uint32_t fg, bg, ulc; };
struct scan {
	uint8_t state;
	/* tracked terminal state */
	uint8_t alt, decckm, keypad, bpaste, cursor_hidden, focus;
	uint16_t mouse, mouse_enc;
	uint16_t stbm_top, stbm_bot;
	struct sgr sgr, saved_sgr;
	uint8_t title_kind;
	uint16_t title_len;
	char title[TITLE_MAX];
	/* parser scratch */
	uint16_t params[NPARAM];
	uint8_t sub[NPARAM];
	uint8_t nparam, ovf, priv, inter;
	uint16_t osc_len;
	char osc[TITLE_MAX + 8];
	uint8_t ev_alt; /* set by scan_feed when alt screen was just entered */
};
void scan_init(struct scan *s);
size_t scan_feed(struct scan *s, const uint8_t *p, size_t n);
int scan_ground(const struct scan *s);
size_t scan_restore(const struct scan *s, char *out, size_t cap);
int scan_same(const struct scan *a, const struct scan *b);

/* ---- ring.c ---- */
struct ring { uint8_t *p; uint64_t head; };
uint64_t ring_start(const struct ring *r);
void ring_write(struct ring *r, struct scan *tail, const uint8_t *d, size_t n);
size_t ring_copy(const struct ring *r, uint64_t from, uint8_t *out, size_t n);

/* ---- paths.c ---- */
struct paths { char dir[DIR_MAX + 1]; };
int valid_id(const char *id);
int paths_init(struct paths *p, int create); /* 0 ok, 1 missing, -1 refused */
int sess_path(const struct paths *p, const char *id, const char *sfx, char *out, size_t cap);
int lock_run(const struct paths *p);
int connect_sock(const char *path);
void remove_stale(const char *path);

/* ---- daemon.c ---- */
void daemon_main(const struct paths *p, const char *id, uint16_t cols, uint16_t rows,
                 uint32_t idle, int readyfd) __attribute__((noreturn));

#endif
