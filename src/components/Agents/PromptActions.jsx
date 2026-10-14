import React from 'react';
import { IS_ANDROID } from '../../platform';
import './PromptActions.css';

/*
 * Quick answers for the prompt an agent (or a shell question) is waiting on:
 * one pill per option parsed from the screen (agentRules.parseChoices), over
 * the bottom-right of the pane. The key that does the same in the terminal
 * (1/2/3, y/n, Esc) is shown on each pill. Clicking sends that option's keys
 * to THIS session only (TerminalView's onAnswer: no broadcast) and the row
 * hides until the next prompt.
 *
 * Desktop: compact pills; the buttons never take the focus (mousedown is
 * prevented), so the keyboard stays in xterm. Android: bigger tap targets,
 * just above the extra-keys row, wrapping when there are many.
 *
 * Rendered by TerminalView inside a zero-height anchor right under the
 * terminal, so it floats over the last rows without resizing the pty.
 */
export default function PromptActions({ choices, onAnswer }) {
  if (!choices || !choices.length) return null;
  return (
    <div className="prompt-actions-anchor">
      <div className={`prompt-actions${IS_ANDROID ? ' prompt-actions-touch' : ''}`} role="group" aria-label="Answer the prompt">
        {choices.map((c, i) => (
          <button
            key={`${i}-${c.label}`}
            type="button"
            className={`pa-pill${c.cancel ? ' pa-cancel' : ''}${c.default ? ' pa-default' : ''}`}
            title={c.hint ? `${c.label} (${c.hint})` : c.label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); onAnswer(c); }}
          >
            {c.hint && <kbd className="pa-key">{c.hint}</kbd>}
            <span className="pa-label">{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
