/* A tiny VT escape-sequence scanner. It does NOT render: it only follows the
 * parser state machine far enough to know (a) whether we are between sequences
 * (a safe replay boundary) and (b) the handful of modes that must be restored
 * on reattach. Input is untrusted pty output: every buffer is fixed-size and
 * every index is bounds-checked. */
#include "keeper.h"

#include <stdio.h>
#include <string.h>

enum { S_GROUND, S_ESC, S_ESC_INT, S_CSI, S_CSI_IGN, S_OSC, S_OSC_ESC, S_STR, S_STR_ESC };

enum { A_BOLD = 1, A_DIM = 2, A_ITALIC = 4, A_BLINK = 8, A_INVERSE = 16, A_HIDDEN = 32,
       A_STRIKE = 64, A_OVERLINE = 128 };

#define C_BASIC (1u << 24)
#define C_IDX (2u << 24)
#define C_RGB (3u << 24)

static void modes_reset(struct scan *s)
{
	s->alt = s->decckm = s->keypad = s->bpaste = s->cursor_hidden = s->focus = 0;
	s->mouse = s->mouse_enc = 0;
	s->stbm_top = s->stbm_bot = 0;
	memset(&s->sgr, 0, sizeof s->sgr);
	memset(&s->saved_sgr, 0, sizeof s->saved_sgr);
}

void scan_init(struct scan *s)
{
	memset(s, 0, sizeof *s);
	s->state = S_GROUND;
}

int scan_ground(const struct scan *s) { return s->state == S_GROUND; }

static unsigned clamp255(unsigned v) { return v > 255 ? 255 : v; }

/* Extended colour (38/48/58). q/m: the values after the 38. Returns how many of
 * them were consumed, or 0 if the spec is invalid. */
static int ext_color(const uint16_t *q, int m, int colon, uint32_t *col)
{
	if (m >= 2 && q[0] == 5) {
		*col = C_IDX | clamp255(q[1]);
		return 2;
	}
	if (m >= 1 && q[0] == 2) {
		const uint16_t *c = NULL;
		if (colon && m >= 5)
			c = q + 2; /* 38:2:<colourspace>:r:g:b */
		else if (m >= 4)
			c = q + 1;
		if (c) {
			*col = C_RGB | clamp255(c[0]) << 16 | clamp255(c[1]) << 8 | clamp255(c[2]);
			return colon ? m : 4;
		}
	}
	return 0;
}

static void sgr_apply(struct scan *s)
{
	struct sgr *g = &s->sgr;
	int n = s->nparam;
	if (n == 0) {
		memset(g, 0, sizeof *g);
		return;
	}
	for (int i = 0; i < n;) {
		unsigned v = s->params[i];
		int j = i + 1;
		while (j < n && s->sub[j])
			j++;
		int ns = j - i - 1; /* colon sub-parameters of this one */
		const uint16_t *sp = s->params + i + 1;
		int next = j;
		switch (v) {
		case 0: memset(g, 0, sizeof *g); break;
		case 1: g->flags |= A_BOLD; break;
		case 2: g->flags |= A_DIM; break;
		case 3: g->flags |= A_ITALIC; break;
		case 4:
			if (ns >= 1 && sp[0] == 0)
				g->ul = 0;
			else
				g->ul = ns >= 1 ? (uint8_t)(sp[0] > 5 ? 5 : sp[0]) : 1;
			break;
		case 5: case 6: g->flags |= A_BLINK; break;
		case 7: g->flags |= A_INVERSE; break;
		case 8: g->flags |= A_HIDDEN; break;
		case 9: g->flags |= A_STRIKE; break;
		case 21: g->ul = 2; break;
		case 22: g->flags &= ~(A_BOLD | A_DIM); break;
		case 23: g->flags &= ~A_ITALIC; break;
		case 24: g->ul = 0; break;
		case 25: g->flags &= ~A_BLINK; break;
		case 27: g->flags &= ~A_INVERSE; break;
		case 28: g->flags &= ~A_HIDDEN; break;
		case 29: g->flags &= ~A_STRIKE; break;
		case 39: g->fg = 0; break;
		case 49: g->bg = 0; break;
		case 53: g->flags |= A_OVERLINE; break;
		case 55: g->flags &= ~A_OVERLINE; break;
		case 59: g->ulc = 0; break;
		case 38: case 48: case 58: {
			uint32_t col = 0, *dst = v == 38 ? &g->fg : v == 48 ? &g->bg : &g->ulc;
			if (ns > 0) {
				if (ext_color(sp, ns, 1, &col))
					*dst = col;
			} else {
				int used = ext_color(s->params + i + 1, n - i - 1, 0, &col);
				if (used) {
					*dst = col;
					next = i + 1 + used;
				}
			}
			break;
		}
		default:
			if ((v >= 30 && v <= 37) || (v >= 90 && v <= 97))
				g->fg = C_BASIC | v;
			else if ((v >= 40 && v <= 47) || (v >= 100 && v <= 107))
				g->bg = C_BASIC | v;
			break;
		}
		i = next;
	}
}

static void set_mode(struct scan *s, unsigned m, int on)
{
	switch (m) {
	case 1: s->decckm = (uint8_t)on; break;
	case 25: s->cursor_hidden = (uint8_t)!on; break;
	case 47: case 1047: case 1049:
		if (on) {
			if (m == 1049)
				s->saved_sgr = s->sgr; /* 1049 includes DECSC */
			s->alt = 1;
			s->ev_alt = 1;
		} else {
			if (s->alt && m == 1049)
				s->sgr = s->saved_sgr;
			s->alt = 0;
		}
		break;
	case 9: case 1000: case 1002: case 1003: s->mouse = on ? (uint16_t)m : 0; break;
	case 1006: s->mouse_enc = on ? 1006 : 0; break;
	case 1004: s->focus = (uint8_t)on; break;
	case 2004: s->bpaste = (uint8_t)on; break;
	}
}

static void csi_dispatch(struct scan *s, uint8_t f)
{
	if (s->priv == '?' && !s->inter && (f == 'h' || f == 'l')) {
		for (int i = 0; i < s->nparam; i++)
			if (!s->sub[i])
				set_mode(s, s->params[i], f == 'h');
		return;
	}
	if (s->priv)
		return;
	if (!s->inter && f == 'm') {
		sgr_apply(s);
	} else if (!s->inter && f == 'r') {
		unsigned top = s->nparam > 0 ? s->params[0] : 0;
		unsigned bot = s->nparam > 1 ? s->params[1] : 0;
		if (top <= 1 && bot == 0) {
			s->stbm_top = s->stbm_bot = 0;
		} else {
			if (top == 0)
				top = 1;
			if (bot && top >= bot)
				return; /* invalid: terminals ignore it */
			s->stbm_top = (uint16_t)top;
			s->stbm_bot = (uint16_t)bot;
		}
	} else if (s->inter == '!' && f == 'p') { /* DECSTR soft reset */
		s->decckm = s->keypad = s->cursor_hidden = 0;
		s->stbm_top = s->stbm_bot = 0;
		memset(&s->sgr, 0, sizeof s->sgr);
		memset(&s->saved_sgr, 0, sizeof s->saved_sgr);
	}
}

/* Drop a trailing, incomplete UTF-8 sequence (left by truncation). */
static size_t utf8_trim(const char *p, size_t n)
{
	size_t k = 0;
	while (k < n && k < 3 && ((unsigned char)p[n - 1 - k] & 0xc0) == 0x80)
		k++;
	if (k == n)
		return n;
	unsigned char lead = (unsigned char)p[n - 1 - k];
	if (lead >= 0xc0) {
		size_t want = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
		if (k + 1 < want)
			return n - k - 1;
	}
	return n;
}

static void osc_dispatch(struct scan *s)
{
	unsigned num = 0;
	size_t i = 0;
	while (i < s->osc_len && i < 4 && s->osc[i] >= '0' && s->osc[i] <= '9')
		num = num * 10 + (unsigned)(s->osc[i++] - '0');
	if (i == 0 || i >= s->osc_len || s->osc[i] != ';' || (num != 0 && num != 2))
		return;
	i++;
	size_t len = s->osc_len - i;
	if (len > TITLE_MAX)
		len = TITLE_MAX;
	len = utf8_trim(s->osc + i, len);
	memcpy(s->title, s->osc + i, len);
	s->title_len = (uint16_t)len;
	s->title_kind = (uint8_t)num;
}

static void step(struct scan *s, uint8_t c)
{
	int cancel = c == 0x18 || c == 0x1a; /* CAN / SUB abort any sequence */
	switch (s->state) {
	case S_GROUND:
		if (c == 0x1b)
			s->state = S_ESC;
		return;
	case S_ESC:
		if (c == 0x1b)
			return;
		if (cancel) {
			s->state = S_GROUND;
			return;
		}
		if (c < 0x20 || c == 0x7f)
			return; /* C0 executes inside ESC */
		switch (c) {
		case '[':
			s->nparam = s->ovf = s->priv = s->inter = 0;
			s->state = S_CSI;
			return;
		case ']':
			s->osc_len = 0;
			s->state = S_OSC;
			return;
		case 'P': case 'X': case '^': case '_':
			s->state = S_STR;
			return;
		case 'c': modes_reset(s); break;
		case '=': s->keypad = 1; break;
		case '>': s->keypad = 0; break;
		case '7': s->saved_sgr = s->sgr; break;
		case '8': s->sgr = s->saved_sgr; break;
		default:
			if (c >= 0x20 && c <= 0x2f) {
				s->state = S_ESC_INT;
				return;
			}
		}
		s->state = S_GROUND;
		return;
	case S_ESC_INT:
		if (c == 0x1b)
			s->state = S_ESC;
		else if (cancel || (c >= 0x30 && c != 0x7f))
			s->state = S_GROUND;
		return;
	case S_CSI:
		if (c >= '0' && c <= '9') {
			if (s->inter) {
				s->state = S_CSI_IGN;
				return;
			}
			if (s->ovf)
				return;
			if (s->nparam == 0) {
				s->nparam = 1;
				s->params[0] = 0;
				s->sub[0] = 0;
			}
			uint32_t v = s->params[s->nparam - 1] * 10u + (uint32_t)(c - '0');
			s->params[s->nparam - 1] = (uint16_t)(v > 65535 ? 65535 : v);
			return;
		}
		if (c == ';' || c == ':') {
			if (s->inter) {
				s->state = S_CSI_IGN;
				return;
			}
			if (s->nparam == 0) {
				s->nparam = 1;
				s->params[0] = 0;
				s->sub[0] = 0;
			}
			if (s->nparam < NPARAM) {
				s->params[s->nparam] = 0;
				s->sub[s->nparam] = c == ':';
				s->nparam++;
			} else {
				s->ovf = 1;
			}
			return;
		}
		if (c >= 0x3c && c <= 0x3f) {
			if (s->nparam == 0 && !s->priv && !s->inter)
				s->priv = c;
			else
				s->state = S_CSI_IGN;
			return;
		}
		if (c >= 0x20 && c <= 0x2f) {
			s->inter = c;
			return;
		}
		if (c >= 0x40 && c <= 0x7e) {
			csi_dispatch(s, c);
			s->state = S_GROUND;
			return;
		}
		if (c == 0x1b)
			s->state = S_ESC;
		else if (cancel)
			s->state = S_GROUND;
		return; /* other C0, DEL, high bytes: ignored */
	case S_CSI_IGN:
		if (c == 0x1b)
			s->state = S_ESC;
		else if (cancel || (c >= 0x40 && c <= 0x7e))
			s->state = S_GROUND;
		return;
	case S_OSC:
		if (c == 0x07) {
			osc_dispatch(s);
			s->state = S_GROUND;
		} else if (c == 0x1b) {
			s->state = S_OSC_ESC;
		} else if (cancel) {
			s->state = S_GROUND;
		} else if (c >= 0x20 && c != 0x7f && s->osc_len < sizeof s->osc) {
			s->osc[s->osc_len++] = (char)c;
		}
		return;
	case S_OSC_ESC:
		osc_dispatch(s);
		s->state = S_ESC;
		if (c == '\\')
			s->state = S_GROUND;
		else
			step(s, c); /* state is S_ESC now: no further recursion */
		return;
	case S_STR:
		if (c == 0x1b)
			s->state = S_STR_ESC;
		else if (cancel)
			s->state = S_GROUND;
		return;
	case S_STR_ESC:
		s->state = S_ESC;
		if (c == '\\')
			s->state = S_GROUND;
		else
			step(s, c);
		return;
	default:
		s->state = S_GROUND;
		return;
	}
}

/* Feeds bytes; stops right after a sequence that entered the alt screen so the
 * caller can snapshot the state at that exact offset. Returns bytes consumed. */
size_t scan_feed(struct scan *s, const uint8_t *p, size_t n)
{
	s->ev_alt = 0;
	for (size_t i = 0; i < n; i++) {
		if (s->state == S_GROUND) {
			const uint8_t *e = memchr(p + i, 0x1b, n - i);
			if (!e)
				return n;
			i = (size_t)(e - p);
		}
		step(s, p[i]);
		if (s->ev_alt)
			return i + 1;
	}
	return n;
}

static int put_color(char *o, size_t cap, int base, uint32_t c)
{
	uint32_t v = c & 0xffffff;
	switch (c & 0xff000000u) {
	case C_BASIC: return snprintf(o, cap, ";%u", (unsigned)v);
	case C_IDX: return snprintf(o, cap, ";%d;5;%u", base, (unsigned)v);
	case C_RGB:
		return snprintf(o, cap, ";%d;2;%u;%u;%u", base, (unsigned)(v >> 16),
		                (unsigned)((v >> 8) & 0xff), (unsigned)(v & 0xff));
	}
	return 0;
}

/* Escape sequences that recreate s's tracked state on a freshly reset terminal.
 * cap must be >= 1024 (worst case is well under that). */
size_t scan_restore(const struct scan *s, char *o, size_t cap)
{
	size_t n = 0;
	int r;
#define PUT(...)                                                   \
	do {                                                       \
		r = snprintf(o + n, cap - n, __VA_ARGS__);         \
		if (r < 0 || (size_t)r >= cap - n)                 \
			return n;                                  \
		n += (size_t)r;                                    \
	} while (0)
	if (cap == 0)
		return 0;
	o[0] = 0;
	if (s->alt)
		PUT("\033[?1049h");
	if (s->stbm_bot)
		PUT("\033[%u;%ur", s->stbm_top ? s->stbm_top : 1u, s->stbm_bot);
	else if (s->stbm_top)
		PUT("\033[%ur", s->stbm_top);
	if (s->decckm)
		PUT("\033[?1h");
	if (s->keypad)
		PUT("\033=");
	if (s->mouse)
		PUT("\033[?%uh", s->mouse);
	if (s->mouse_enc)
		PUT("\033[?%uh", s->mouse_enc);
	if (s->focus)
		PUT("\033[?1004h");
	if (s->bpaste)
		PUT("\033[?2004h");
	if (s->cursor_hidden)
		PUT("\033[?25l");
	const struct sgr *g = &s->sgr;
	if (g->flags || g->ul || g->fg || g->bg || g->ulc) {
		static const struct { uint16_t bit; uint8_t code; } fl[] = {
			{ A_BOLD, 1 }, { A_DIM, 2 }, { A_ITALIC, 3 }, { A_BLINK, 5 }, { A_INVERSE, 7 },
			{ A_HIDDEN, 8 }, { A_STRIKE, 9 }, { A_OVERLINE, 53 } };
		PUT("\033[0");
		for (size_t i = 0; i < sizeof fl / sizeof fl[0]; i++)
			if (g->flags & fl[i].bit)
				PUT(";%u", fl[i].code);
		if (g->ul == 1)
			PUT(";4");
		else if (g->ul)
			PUT(";4:%u", g->ul);
		r = put_color(o + n, cap - n, 38, g->fg);
		if (r < 0 || (size_t)r >= cap - n) return n;
		n += (size_t)r;
		r = put_color(o + n, cap - n, 48, g->bg);
		if (r < 0 || (size_t)r >= cap - n) return n;
		n += (size_t)r;
		if ((g->ulc & 0xff000000u) != C_BASIC) {
			r = put_color(o + n, cap - n, 58, g->ulc);
			if (r < 0 || (size_t)r >= cap - n) return n;
			n += (size_t)r;
		}
		PUT("m");
	}
	if (s->title_len && n + s->title_len + 16 < cap) {
		PUT("\033]%u;", s->title_kind);
		memcpy(o + n, s->title, s->title_len);
		n += s->title_len;
		PUT("\007");
	}
#undef PUT
	return n;
}

/* Tracked state equality (used by the fuzzer's restore round-trip check). */
int scan_same(const struct scan *a, const struct scan *b)
{
	return a->alt == b->alt && a->decckm == b->decckm && a->keypad == b->keypad &&
	       a->bpaste == b->bpaste && a->cursor_hidden == b->cursor_hidden &&
	       a->focus == b->focus && a->mouse == b->mouse && a->mouse_enc == b->mouse_enc &&
	       a->stbm_top == b->stbm_top && a->stbm_bot == b->stbm_bot &&
	       a->sgr.flags == b->sgr.flags && a->sgr.ul == b->sgr.ul && a->sgr.fg == b->sgr.fg &&
	       a->sgr.bg == b->sgr.bg && a->sgr.ulc == b->sgr.ulc && a->title_len == b->title_len &&
	       (!a->title_len || (a->title_kind == b->title_kind &&
	                          !memcmp(a->title, b->title, a->title_len)));
}
