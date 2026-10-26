/*
 * "Arrange panes" (the title bar button): pure transforms of a layout tree
 * (layoutTree.js). No React; scripts/lib/check-arrange.js bundles it with
 * esbuild and tests it.
 *
 * Every transform keeps exactly the same leaves (same tabIds, so the same
 * live sessions) and keeps them in layout order: the first leaf names the
 * tab, so the tab keeps its name. Only positions and ratios change.
 *
 *   equalize(tree)        same structure, every pane the same size
 *   arrange(tree, mode)   'equal' | 'columns' | 'rows' | 'grid'
 */
import { collectIds, leaf } from './layoutTree';

export const ARRANGE_MODES = ['equal', 'columns', 'rows', 'grid'];

const H = 'horizontal';   // side by side
const V = 'vertical';     // stacked

/* How many panes a subtree lays side by side along `dir`: a split in that
   direction adds its children up, one across it takes the widest child.
   With every split in the same direction it is just the leaf count. */
function span(node, dir) {
  if (!node || node.type === 'terminal') return 1;
  const a = span(node.children[0], dir);
  const b = span(node.children[1], dir);
  return node.direction === dir ? a + b : Math.max(a, b);
}

/* Same structure; each split shares its space by how many panes each side
   holds along its axis, so 4 nested columns are 25 % each, not 50/25/12.5/12.5 */
export function equalize(tree) {
  if (!tree || tree.type === 'terminal') return tree;
  const children = tree.children.map(equalize);
  const a = span(children[0], tree.direction);
  const b = span(children[1], tree.direction);
  return { ...tree, ratio: a / (a + b), children };
}

/* Subtrees in a line along `dir`, each the same size (balanced, so the
   tree stays shallow). Each item weighs 1. */
function line(nodes, dir) {
  if (nodes.length === 1) return nodes[0];
  const mid = Math.ceil(nodes.length / 2);
  return {
    type: 'split', direction: dir, ratio: mid / nodes.length,
    children: [line(nodes.slice(0, mid), dir), line(nodes.slice(mid), dir)],
  };
}

/* ceil(sqrt(n)) columns, filled row by row; a short last row is stretched
   (3 panes: two on top, one below at full width) */
function grid(ids) {
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows = [];
  for (let i = 0; i < ids.length; i += cols) rows.push(line(ids.slice(i, i + cols).map(leaf), H));
  return line(rows, V);
}

export function arrange(tree, mode) {
  if (!tree || tree.type === 'terminal') return tree;
  const ids = collectIds(tree);
  switch (mode) {
    case 'columns': return line(ids.map(leaf), H);
    case 'rows': return line(ids.map(leaf), V);
    case 'grid': return grid(ids);
    case 'equal': return equalize(tree);
    default: return tree;
  }
}
