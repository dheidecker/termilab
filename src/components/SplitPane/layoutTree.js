/*
 * Split layouts as pure data (no React). Tested by a node script; the reducer
 * in AppContext and SessionStage only call into here.
 *
 * Tree:
 *   leaf   { type: 'terminal', tabId }
 *   split  { type: 'split', direction: 'horizontal'|'vertical', ratio, children: [a, b] }
 * 'horizontal' = side by side (col-resize divider), 'vertical' = stacked.
 *
 * Model: every terminal session is one entry of `state.tabs`. A top-level tab
 * (not hidden) is a *group*; `layouts[groupId]` is its tree, and a group with
 * no entry is the single leaf of itself. Every other pane of a group is a tab
 * with `hidden: true`. The group id is always one of its own leaves: when that
 * pane leaves (closed, detached, moved), the first remaining pane is promoted
 * to group, takes the old tab's place in the bar, and `renamed` says so.
 */

export const leaf = (tabId) => ({ type: 'terminal', tabId });

export function collectIds(node) {
  if (!node) return [];
  if (node.type === 'terminal') return [node.tabId];
  return [...collectIds(node.children[0]), ...collectIds(node.children[1])];
}

export const containsId = (node, id) => collectIds(node).includes(id);

/* Replace the leaf `targetId` with a split holding `subtree` on `side`. */
export function insertAt(tree, targetId, subtree, side) {
  if (!tree) return subtree;
  if (tree.type === 'terminal') {
    if (tree.tabId !== targetId) return tree;
    const direction = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
    const first = side === 'left' || side === 'top';
    return { type: 'split', direction, ratio: 0.5, children: first ? [subtree, tree] : [tree, subtree] };
  }
  return { ...tree, children: tree.children.map(c => insertAt(c, targetId, subtree, side)) };
}

/* The tree without leaf `id`; its parent split collapses into the sibling.
   null when the tree was that leaf. */
export function removeLeaf(tree, id) {
  if (!tree) return null;
  if (tree.type === 'terminal') return tree.tabId === id ? null : tree;
  const a = removeLeaf(tree.children[0], id);
  const b = removeLeaf(tree.children[1], id);
  if (!a) return b;
  if (!b) return a;
  if (a === tree.children[0] && b === tree.children[1]) return tree;
  return { ...tree, children: [a, b] };
}

export function swapLeaves(tree, a, b) {
  if (!tree) return tree;
  if (tree.type === 'terminal') {
    if (tree.tabId === a) return leaf(b);
    if (tree.tabId === b) return leaf(a);
    return tree;
  }
  return { ...tree, children: tree.children.map(c => swapLeaves(c, a, b)) };
}

/* Move leaf `id` next to leaf `targetId` (zone = side), or swap them
   (zone 'center'). Same tree back when nothing would change. */
export function moveLeaf(tree, id, targetId, zone) {
  if (id === targetId || !containsId(tree, id) || !containsId(tree, targetId)) return tree;
  if (zone === 'center') return swapLeaves(tree, id, targetId);
  return insertAt(removeLeaf(tree, id), targetId, leaf(id), zone);
}

/* path = child indexes from the root to a split node */
export function setRatioAt(tree, path, ratio) {
  if (!tree || tree.type !== 'split') return tree;
  if (path.length === 0) return { ...tree, ratio };
  const [i, ...rest] = path;
  const children = tree.children.slice();
  children[i] = setRatioAt(children[i], rest, ratio);
  return { ...tree, children };
}

/* VS Code-style drop zone for a pointer at (x, y) over `rect`: the nearest
   edge, or 'center' inside the middle half of both axes when allowed. */
export function zoneFromPoint(rect, x, y, allowCenter) {
  const fx = rect.width ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height ? (y - rect.top) / rect.height : 0.5;
  if (allowCenter && fx > 0.25 && fx < 0.75 && fy > 0.25 && fy < 0.75) return 'center';
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return Object.keys(d).reduce((best, k) => (d[k] < d[best] ? k : best), 'left');
}

/* ── Groups ── */

export const layoutOf = (layouts, groupId) => (layouts && layouts[groupId]) || leaf(groupId);

export const isTerminalTab = (t) => !!t && (t.type === 'terminal' || t.type === 'local-terminal');

/* The top-level tab whose layout holds pane `id` (itself when standalone) */
export function groupOf(model, id) {
  const tab = model.tabs.find(t => t.id === id);
  if (!tab) return null;
  if (!tab.hidden) return id;
  for (const [gid, tree] of Object.entries(model.layouts || {})) {
    if (containsId(tree, id)) return gid;
  }
  return null;
}

export function memberTabs(model, groupId) {
  const byId = new Map(model.tabs.map(t => [t.id, t]));
  return collectIds(layoutOf(model.layouts, groupId)).map(id => byId.get(id)).filter(Boolean);
}

/* "web-1 +2", and a tooltip listing every pane */
export function groupLabel(members) {
  if (!members.length) return { label: '', title: '' };
  const names = members.map(t => t.label || 'Terminal');
  if (names.length === 1) return { label: names[0], title: names[0] };
  return { label: `${names[0]} +${names.length - 1}`, title: names.join('\n') };
}

const setLayout = (layouts, groupId, tree) => {
  const next = { ...layouts };
  if (!tree || tree.type === 'terminal') delete next[groupId];
  else next[groupId] = tree;
  return next;
};

const patchTabs = (tabs, ids, patch) => tabs.map(t => (ids.includes(t.id) ? { ...t, ...patch } : t));

function moveInArray(tabs, id, index) {
  const tab = tabs.find(t => t.id === id);
  const rest = tabs.filter(t => t.id !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, tab);
  return rest;
}

/* Take pane `id` out of its group. The tab stays in `tabs` (the caller
   decides what it becomes). Promotes a new group id when `id` was the group. */
function extract(model, id) {
  const gid = groupOf(model, id);
  if (!gid) return { model, renamed: {} };
  const tree = layoutOf(model.layouts, gid);
  const rest = removeLeaf(tree, id);
  if (!rest) return { model, renamed: {}, alone: true };  // standalone tab: nothing to take out of
  if (gid !== id) {
    return { model: { ...model, layouts: setLayout(model.layouts, gid, rest) }, renamed: {} };
  }
  const heir = collectIds(rest)[0];
  let layouts = setLayout(model.layouts, gid, null);
  layouts = setLayout(layouts, heir, rest);
  let tabs = patchTabs(model.tabs, [heir], { hidden: false });
  tabs = moveInArray(tabs, heir, tabs.findIndex(t => t.id === gid));
  return { model: { ...model, tabs, layouts }, renamed: { [gid]: heir } };
}

/* A whole top-level tab (all its panes) dropped next to `targetPaneId` */
export function mergeTab(model, srcId, targetGroupId, targetPaneId, side) {
  const src = model.tabs.find(t => t.id === srcId);
  if (!src || src.hidden || !isTerminalTab(src) || srcId === targetGroupId) return { model, renamed: {} };
  const target = layoutOf(model.layouts, targetGroupId);
  if (!containsId(target, targetPaneId)) return { model, renamed: {} };
  const sub = layoutOf(model.layouts, srcId);
  const layouts = setLayout(setLayout(model.layouts, srcId, null), targetGroupId, insertAt(target, targetPaneId, sub, side));
  return { model: { ...model, layouts, tabs: patchTabs(model.tabs, collectIds(sub), { hidden: true }) }, renamed: {} };
}

/* A pane dropped on a pane: reorder/swap in its group, or join another group */
export function movePane(model, paneId, targetGroupId, targetPaneId, zone) {
  const none = { model, renamed: {} };
  if (paneId === targetPaneId) return none;
  const target = layoutOf(model.layouts, targetGroupId);
  if (!containsId(target, targetPaneId)) return none;
  const srcGroup = groupOf(model, paneId);
  if (!srcGroup) return none;
  if (srcGroup === targetGroupId) {
    const tree = moveLeaf(target, paneId, targetPaneId, zone);
    return tree === target ? none : { model: { ...model, layouts: setLayout(model.layouts, targetGroupId, tree) }, renamed: {} };
  }
  const side = zone === 'center' ? 'right' : zone;
  const { model: m, renamed } = extract(model, paneId);
  const tree = insertAt(layoutOf(m.layouts, targetGroupId), targetPaneId, leaf(paneId), side);
  return {
    model: { ...m, tabs: patchTabs(m.tabs, [paneId], { hidden: true }), layouts: setLayout(m.layouts, targetGroupId, tree) },
    renamed,
  };
}

/* Pane back to its own top-level tab, right after its (possibly renamed) group */
export function detachPane(model, paneId) {
  const r = extract(model, paneId);
  if (r.alone || r.model === model) return { model, renamed: {} };
  const gid = r.renamed[paneId] || groupOf(model, paneId);
  let tabs = patchTabs(r.model.tabs, [paneId], { hidden: false });
  /* moveInArray's index is into the list without the pane: counting it here
     would land one too far when the pane sat before its group (P,G,Y → G,Y,P) */
  tabs = moveInArray(tabs, paneId, tabs.filter(t => t.id !== paneId).findIndex(t => t.id === gid) + 1);
  return { model: { ...r.model, tabs }, renamed: r.renamed };
}

/* Every pane of a group becomes its own tab, in layout order */
export function ungroup(model, groupId) {
  let m = model;
  const ids = collectIds(layoutOf(model.layouts, groupId));
  for (const id of ids.slice(1).reverse()) m = detachPane(m, id).model;
  return { model: m, renamed: {} };
}

/* Closing tabs: each leaves its group (promoting an heir if needed) and goes */
export function removeTabs(model, ids) {
  let m = model;
  const renamed = {};
  for (const id of ids) {
    if (!m.tabs.some(t => t.id === id)) continue;
    const r = extract(m, id);
    m = r.model;
    for (const [from, to] of Object.entries(r.renamed)) {
      for (const k of Object.keys(renamed)) if (renamed[k] === from) renamed[k] = to;
      renamed[from] = to;
    }
    m = { ...m, tabs: m.tabs.filter(t => t.id !== id), layouts: setLayout(m.layouts, id, null) };
  }
  return { model: m, renamed };
}

/* A new local terminal next to `paneId` (the split buttons) */
export function splitWith(model, groupId, paneId, newTab, direction) {
  const tree = layoutOf(model.layouts, groupId);
  if (!containsId(tree, paneId)) return { model, renamed: {} };
  const side = direction === 'horizontal' ? 'right' : 'bottom';
  return {
    model: {
      ...model,
      tabs: [...model.tabs, { ...newTab, hidden: true }],
      layouts: setLayout(model.layouts, groupId, insertAt(tree, paneId, leaf(newTab.id), side)),
    },
    renamed: {},
  };
}

/* The pane keyboard input goes to in a group: the remembered one while it is
   still there, else the first. */
export function focusedPaneOf(state, groupId) {
  const tree = layoutOf(state.layouts, groupId);
  const f = state.focusedPane && state.focusedPane[groupId];
  return f && containsId(tree, f) ? f : collectIds(tree)[0];
}

/* Fold a model result back into app state: renames follow activeTabId and the
   focus map, an active tab that got hidden hands over to its group, and stale
   focus entries go. */
export function applyModel(state, { model, renamed }, focus) {
  if (model.tabs === state.tabs && model.layouts === state.layouts && !focus) return state;
  let activeTabId = renamed[state.activeTabId] || state.activeTabId;
  const focusedPane = {};
  for (const [g, p] of Object.entries(state.focusedPane || {})) focusedPane[renamed[g] || g] = p;
  if (focus) focusedPane[focus.groupId] = focus.paneId;
  const next = { ...state, tabs: model.tabs, layouts: model.layouts, activeTabId, focusedPane };
  const active = next.tabs.find(t => t.id === activeTabId);
  if (active && active.hidden) {
    next.activeTabId = groupOf(next, activeTabId);
    next.focusedPane[next.activeTabId] = activeTabId;
  }
  for (const g of Object.keys(next.focusedPane)) {
    const t = next.tabs.find(x => x.id === g);
    if (!t || t.hidden || !containsId(layoutOf(next.layouts, g), next.focusedPane[g])) delete next.focusedPane[g];
  }
  return next;
}
