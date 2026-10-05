import './Keeper.css';

/*
 * A short line at the bottom of the window that goes away on its own
 * ("That session has ended"). Imperative, like askKeeperClose: any code
 * path can call it without owning state. One at a time: a new one replaces
 * the one showing.
 */
let current = null;

export function showToast(text, ms = 3200) {
  if (typeof document === 'undefined' || !text) return;
  if (current) current.remove();
  const el = document.createElement('div');
  el.className = 'termilab-toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  current = el;
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); if (current === el) current = null; }, 200);
  }, ms);
}
