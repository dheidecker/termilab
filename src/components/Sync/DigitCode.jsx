import React from 'react';
import { toDigits } from './helpers';
import './Sync.css';

/**
 * The six pairing digits, laid out 3 + 3 so they are easy to read out loud
 * over the phone. They are derived from both devices' ephemeral public keys —
 * the server never generates them — which is why comparing them detects a
 * man in the middle.
 */
export default function DigitCode({ digits, size = 'lg' }) {
  const chars = toDigits(digits);
  return (
    <div
      className={`sync-digits sync-digits-${size}`}
      role="img"
      aria-label={`Pairing code: ${chars.join(' ')}`}
    >
      {chars.map((char, i) => (
        <React.Fragment key={i}>
          {i === 3 && <span className="sync-digits-sep" aria-hidden="true" />}
          <span className="sync-digit">{char}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
