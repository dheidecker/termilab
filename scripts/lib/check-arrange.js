/**
 * Seccion AR del arnes del main (scripts/check-main.js): "Arrange panes" de la
 * barra de titulo, con src/components/SplitPane/arrange.js empaquetado con
 * esbuild (funciones puras sobre el arbol de layout).
 *
 *  AR1  4 columnas anidadas (50/25/12.5/12.5) → equal da 25 % cada una.
 *  AR2  equal respeta la estructura; un arbol mixto reparte por eje.
 *  AR3  Columns, Rows y Grid conservan exactamente el mismo conjunto (y orden)
 *       de ids de hoja, y con ellos las sesiones; el grupo sigue siendo hoja.
 *  AR4  Columns / Rows: todas las hojas del mismo ancho / alto.
 *  AR5  Grid: 4 → 2x2; 3 → dos arriba y una abajo a todo el ancho; 6 → 3x2.
 *  AR6  1 hoja (o sin arbol) → sin cambios; el reducer no toca el estado.
 *
 * Solo esta seccion: TERMILAB_CHECK_ONLY=AR, o `node scripts/lib/check-arrange.js`.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/* Rectangulo (fracciones de 0..1) de cada hoja, como lo dibuja SessionStage */
function rects(node, box = { x: 0, y: 0, w: 1, h: 1 }, out = {}) {
  if (node.type === 'terminal') { out[node.tabId] = box; return out; }
  const r = node.ratio;
  if (node.direction === 'horizontal') {
    rects(node.children[0], { ...box, w: box.w * r }, out);
    rects(node.children[1], { ...box, x: box.x + box.w * r, w: box.w * (1 - r) }, out);
  } else {
    rects(node.children[0], { ...box, h: box.h * r }, out);
    rects(node.children[1], { ...box, y: box.y + box.h * r, h: box.h * (1 - r) }, out);
  }
  return out;
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);
const leafNode = (id) => ({ type: 'terminal', tabId: id });
const split = (direction, ratio, a, b) => ({ type: 'split', direction, ratio, children: [a, b] });

async function seccionArrange({ check, ROOT }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termilab-ar-'));
  const out = path.join(tmp, 'arrange.cjs');
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [
    path.join(ROOT, 'src', 'components', 'SplitPane', 'arrange.js'),
    '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`, '--log-level=error',
  ], { stdio: 'pipe' });
  const A = require(out);
  const ids = (t) => Object.keys(rects(t));

  /* a | (b | (c | d)), los ratios que deja dividir y dividir: 50/25/12.5/12.5 */
  const nested4 = split('horizontal', 0.5, leafNode('a'),
    split('horizontal', 0.5, leafNode('b'), split('horizontal', 0.5, leafNode('c'), leafNode('d'))));
  const many = (n) => Array.from({ length: n }, (_, i) => `p${i}`)
    .reduceRight((acc, id) => (acc ? split(i0(id), 0.5, leafNode(id), acc) : leafNode(id)), null);
  const i0 = (id) => (Number(id.slice(1)) % 2 ? 'vertical' : 'horizontal');

  try {
    await check('AR1 4 columnas anidadas → equal = 25 % cada una', () => {
      const before = rects(nested4);
      near(before.d.w, 0.125, 'antes d');
      const r = rects(A.arrange(nested4, 'equal'));
      for (const id of ['a', 'b', 'c', 'd']) { near(r[id].w, 0.25, `ancho ${id}`); near(r[id].h, 1, `alto ${id}`); }
    });

    await check('AR2 equal respeta la estructura y reparte por eje en un arbol mixto', () => {
      const t = A.arrange(nested4, 'equal');
      assert.deepStrictEqual(JSON.stringify(t, (k, v) => (k === 'ratio' ? undefined : v)),
        JSON.stringify(nested4, (k, v) => (k === 'ratio' ? undefined : v)));
      /* a | (b / c): a la mitad del ancho, b y c medio alto cada una */
      const mixed = split('horizontal', 0.8, leafNode('a'), split('vertical', 0.3, leafNode('b'), leafNode('c')));
      const r = rects(A.arrange(mixed, 'equal'));
      near(r.a.w, 0.5, 'a'); near(r.b.w, 0.5, 'b'); near(r.b.h, 0.5, 'b alto'); near(r.c.h, 0.5, 'c alto');
      /* (a | b) / (c | d | e) en filas: alto 50/50 */
      const rows = split('vertical', 0.2, split('horizontal', 0.5, leafNode('a'), leafNode('b')),
        split('horizontal', 0.5, leafNode('c'), split('horizontal', 0.5, leafNode('d'), leafNode('e'))));
      const r2 = rects(A.arrange(rows, 'equal'));
      near(r2.a.h, 0.5, 'fila 1'); near(r2.c.h, 0.5, 'fila 2');
      near(r2.a.w, 0.5, 'a'); for (const id of ['c', 'd', 'e']) near(r2[id].w, 1 / 3, id);
    });

    await check('AR3 Columns, Rows y Grid conservan los mismos ids de hoja (y sesiones), en el mismo orden', () => {
      for (const n of [2, 3, 4, 5, 7, 9]) {
        const t = many(n);
        const want = ids(t);
        for (const mode of A.ARRANGE_MODES) {
          const got = A.arrange(t, mode);
          assert.deepStrictEqual(ids(got), want, `${mode} n=${n}`);
          /* el reducer: mismas pestanas (sessionId incluido), solo cambia layouts */
          const tabs = want.map((id, i) => ({ id, sessionId: `s-${i}`, hidden: i > 0 }));
          const state = { tabs, layouts: { [want[0]]: t } };
          const next = { ...state, layouts: { ...state.layouts, [want[0]]: got } };
          assert.strictEqual(next.tabs, state.tabs);
          assert.deepStrictEqual(ids(next.layouts[want[0]]).map(id => tabs.find(x => x.id === id).sessionId).sort(),
            tabs.map(x => x.sessionId).sort(), `${mode} n=${n} sesiones`);
          assert.ok(ids(got).includes(want[0]), 'el grupo sigue siendo una hoja');
        }
      }
    });

    await check('AR4 Columns = mismo ancho, Rows = mismo alto', () => {
      for (const n of [2, 3, 4, 5, 8]) {
        const c = rects(A.arrange(many(n), 'columns'));
        for (const id of Object.keys(c)) { near(c[id].w, 1 / n, `col ${id} n=${n}`); near(c[id].h, 1, 'col alto'); }
        const r = rects(A.arrange(many(n), 'rows'));
        for (const id of Object.keys(r)) { near(r[id].h, 1 / n, `fila ${id} n=${n}`); near(r[id].w, 1, 'fila ancho'); }
      }
    });

    await check('AR5 Grid: 4 → 2x2; 3 → dos arriba + una abajo a todo el ancho; 6 → 3x2', () => {
      const g4 = rects(A.arrange(nested4, 'grid'));
      assert.deepStrictEqual(Object.values(g4).map(b => [b.x, b.y, b.w, b.h]),
        [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]);
      const g3 = rects(A.arrange(many(3), 'grid'));
      assert.deepStrictEqual(Object.values(g3).map(b => [b.x, b.y, b.w, b.h]),
        [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 1, 0.5]]);
      const g6 = rects(A.arrange(many(6), 'grid'));
      for (const b of Object.values(g6)) { near(b.w, 1 / 3, 'g6 ancho'); near(b.h, 0.5, 'g6 alto'); }
    });

    await check('AR6 1 hoja o sin arbol → sin cambios', () => {
      const one = leafNode('solo');
      for (const mode of A.ARRANGE_MODES) {
        assert.strictEqual(A.arrange(one, mode), one, mode);
        assert.strictEqual(A.arrange(null, mode), null, mode);
      }
      /* el reducer: una pestana sin layouts[g] (un solo panel) no cambia el estado */
      const src = fs.readFileSync(path.join(ROOT, 'src', 'contexts', 'AppContext.jsx'), 'utf-8');
      const body = src.slice(src.indexOf("case 'ARRANGE_PANES'"), src.indexOf("case 'UPDATE_TAB'"));
      assert.ok(/if \(!tree\) return state;/.test(body), 'ARRANGE_PANES sin arbol debe devolver el mismo estado');
      assert.ok(/=== JSON\.stringify\(tree\)\) return state;/.test(body), 'sin cambios debe devolver el mismo estado');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { seccionArrange };

if (require.main === module) {
  let failures = 0;
  const check = (name, fn) => Promise.resolve().then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((e) => { failures++; console.log(`  FALLA ${name}\n         ${e && e.message}`); });
  seccionArrange({ check, ROOT: path.join(__dirname, '..', '..') })
    .then(() => { console.log(failures ? `\n${failures} fallidas` : '\nTodo en verde (AR)'); process.exit(failures ? 1 : 0); });
}
