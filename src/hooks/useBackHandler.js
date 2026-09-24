/*
 * The Android back button, as a stack of "close what is on top" handlers.
 *
 * A component with something dismissable open (modal, drawer, menu, search
 * bar) registers a handler while it is open; the newest open thing closes
 * first. Under all of them sits App's navigation fallback (useBackFallback:
 * session tab -> home, section -> Hosts). When nothing takes the press,
 * handleBack() returns false and mobile/web/entry.jsx sends the app to the
 * background.
 *
 * Harmless on desktop: nothing calls handleBack() there.
 */
import { useEffect, useRef } from 'react';

const stack = [];
let fallback = null;

/**
 * Runs the newest handler first. A handler returns false to pass the press to
 * the one below it (App's fallback does when it is already at Hosts home).
 * @returns {boolean} whether something handled the press
 */
export function handleBack() {
  const chain = [...stack].reverse();
  if (fallback) chain.push(fallback);
  for (const entry of chain) {
    try {
      if (entry.current() !== false) return true;
    } catch (err) {
      console.error('[back] handler threw:', err);
      return true;
    }
  }
  return false;
}

/**
 * @param {boolean} active  register only while the thing is open
 * @param {() => (boolean|void)} handler  close it; return false to pass
 */
export function useBackHandler(active, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    // The ref, not the function: a re-render must not move it to the top.
    const entry = { current: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** App's navigation, tried after every open thing. One at a time. */
export function useBackFallback(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const entry = { current: () => ref.current() };
    fallback = entry;
    return () => { if (fallback === entry) fallback = null; };
  }, []);
}
