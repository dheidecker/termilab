/*
 * "The agent finished" sound. Claude Code, Codex and other agent CLIs signal
 * the end of a turn with the terminal bell (BEL) or a desktop-notification
 * escape (OSC 9, OSC 777 notify, OSC 99). The chime is synthesised with Web
 * Audio, so there is no asset to ship and it works on desktop and Android.
 */

let ctx = null;
let lastAt = 0;
const MIN_GAP_MS = 1500;        // a burst of bells is one chime

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** Two soft notes (E6 → A6), ~0.35 s. Throttled across all terminals. */
export function playChime(volume = 0.18) {
  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) return false;
  lastAt = now;
  const ac = audio();
  if (!ac) return false;
  const t0 = ac.currentTime + 0.01;
  [[1318.5, 0], [1760, 0.12]].forEach(([freq, delay]) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.25);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + 0.27);
  });
  return true;
}

/**
 * "An agent needs you" (a permission prompt, a y/n question): its own
 * sound, so it is told apart from "finished" without looking. Lower and
 * softer (triangle wave, A5 then D6 bending up to E6), the rise of a
 * spoken question, ~0.5 s. Throttled on its own.
 */
let lastQuestionAt = 0;
export function playQuestionChime(volume = 0.16) {
  const now = Date.now();
  if (now - lastQuestionAt < MIN_GAP_MS) return false;
  lastQuestionAt = now;
  const ac = audio();
  if (!ac) return false;
  const t0 = ac.currentTime + 0.01;
  [[880, 0, 0.18, null], [1174.7, 0.16, 0.34, 1318.5]].forEach(([freq, delay, len, bendTo]) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0 + delay);
    if (bendTo) osc.frequency.exponentialRampToValueAtTime(bendTo, t0 + delay + len * 0.7);
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + len);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + delay);
    osc.stop(t0 + delay + len + 0.02);
  });
  return true;
}

/* A plain BEL right after the user typed is a shell complaining (failed tab
   completion, backspace at the start of the line), not an agent finishing. */
export const TYPING_QUIET_MS = 2000;
