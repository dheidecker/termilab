import React from 'react';

/**
 * Illustration for the "New Port Forwarding" wizard: this computer → firewall
 * → SSH server, with the arrows pointing the way connections travel for each
 * type. Pure SVG coloured by theme tokens (see .pfd-* in PortForwarding.css).
 */

const Laptop = ({ x, y }) => (
  <g className="pfd-node">
    <rect x={x} y={y} width="54" height="36" rx="4" />
    <rect x={x + 6} y={y + 6} width="42" height="24" rx="1.5" className="pfd-screen" />
    <path d={`M${x - 7} ${y + 40} h68 l-5 7 h-58 z`} />
  </g>
);

const Firewall = ({ x, y }) => (
  <g className="pfd-wall">
    <rect x={x} y={y} width="24" height="70" rx="2" />
    {[14, 28, 42, 56].map(dy => <line key={dy} x1={x} y1={y + dy} x2={x + 24} y2={y + dy} />)}
    {[0, 14, 28, 42, 56].map((dy, i) => (
      <line key={`v${dy}`} x1={x + (i % 2 ? 8 : 16)} y1={y + dy} x2={x + (i % 2 ? 8 : 16)} y2={y + dy + 14} />
    ))}
  </g>
);

const Server = ({ x, y }) => (
  <g className="pfd-node">
    <rect x={x} y={y} width="46" height="20" rx="3" />
    <rect x={x} y={y + 24} width="46" height="20" rx="3" />
    <circle cx={x + 9} cy={y + 10} r="2" className="pfd-dot" />
    <circle cx={x + 9} cy={y + 34} r="2" className="pfd-dot" />
    <line x1={x + 18} y1={y + 10} x2={x + 38} y2={y + 10} />
    <line x1={x + 18} y1={y + 34} x2={x + 38} y2={y + 34} />
  </g>
);

const Database = ({ x, y }) => (
  <g className="pfd-node">
    <ellipse cx={x + 20} cy={y + 6} rx="20" ry="6" />
    <path d={`M${x} ${y + 6} v30 a20 6 0 0 0 40 0 v-30`} />
    <path d={`M${x} ${y + 21} a20 6 0 0 0 40 0`} />
  </g>
);

const Globe = ({ cx, cy, r = 16 }) => (
  <g className="pfd-node">
    <circle cx={cx} cy={cy} r={r} />
    <ellipse cx={cx} cy={cy} rx={r * 0.45} ry={r} />
    <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} />
  </g>
);

const Label = ({ x, y, children, sub }) => (
  <text x={x} y={y} textAnchor="middle" className={sub ? 'pfd-sub' : 'pfd-label'}>{children}</text>
);

export default function ForwardDiagram({ type }) {
  const id = `pfd-${type}`;
  const tunnel = { className: 'pfd-tunnel', markerEnd: `url(#${id}-a)` };
  const plain = { className: 'pfd-link', markerEnd: `url(#${id}-p)` };

  return (
    <svg
      className="pf-diagram"
      viewBox="0 0 400 150"
      role="img"
      aria-label={{
        local: 'This computer connects through the firewall to the SSH server, which connects on to the destination.',
        remote: 'Connections to a port on the SSH server come back through the firewall to this computer.',
        dynamic: 'Apps on this computer use a SOCKS5 proxy that reaches any host through the SSH server.',
      }[type]}
    >
      <defs>
        <marker id={`${id}-a`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" className="pfd-head-accent" />
        </marker>
        <marker id={`${id}-p`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" className="pfd-head" />
        </marker>
      </defs>

      <Laptop x={22} y={38} />
      <Firewall x={150} y={30} />
      <Server x={226} y={42} />
      <Label x={49} y={112}>{type === 'dynamic' ? 'Apps via SOCKS5' : 'This computer'}</Label>
      <Label x={249} y={112}>SSH server</Label>

      {type === 'local' && (
        <>
          <line x1="86" y1="64" x2="218" y2="64" {...tunnel} />
          <line x1="280" y1="64" x2="326" y2="64" {...plain} />
          <Database x={336} y={42} />
          <Label x={49} y={127} sub>127.0.0.1:8080</Label>
          <Label x={356} y={112}>Destination</Label>
          <Label x={356} y={127} sub>db:5432</Label>
        </>
      )}

      {type === 'remote' && (
        <>
          <line x1="218" y1="64" x2="86" y2="64" {...tunnel} />
          <line x1="336" y1="64" x2="282" y2="64" {...plain} />
          <Globe cx={358} cy={64} />
          <Label x={49} y={127} sub>localhost:3000</Label>
          <Label x={249} y={127} sub>port 9000</Label>
          <Label x={358} y={112}>Clients</Label>
        </>
      )}

      {type === 'dynamic' && (
        <>
          <line x1="86" y1="64" x2="218" y2="64" {...tunnel} />
          <line x1="280" y1="58" x2="334" y2="30" {...plain} />
          <line x1="280" y1="64" x2="332" y2="64" {...plain} />
          <line x1="280" y1="70" x2="334" y2="98" {...plain} />
          <Globe cx={352} cy={24} r={11} />
          <Globe cx={352} cy={64} r={11} />
          <Globe cx={352} cy={104} r={11} />
          <Label x={49} y={127} sub>127.0.0.1:1080</Label>
          <Label x={352} y={134}>Any host</Label>
        </>
      )}
    </svg>
  );
}
