import React from 'react';

/* Inline stroke icons shared by the sidebar, the tab strip and the Hosts view.
   All drawn on a 24px grid and coloured with currentColor. */

const Svg = ({ children, strokeWidth = 1.8, ...rest }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    {children}
  </svg>
);

export const ServerIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <line x1="7" y1="7.5" x2="7.01" y2="7.5" />
    <line x1="7" y1="16.5" x2="7.01" y2="16.5" />
    <line x1="11" y1="7.5" x2="17" y2="7.5" />
    <line x1="11" y1="16.5" x2="17" y2="16.5" />
  </Svg>
);

/* A stack of three boxes: the home tab and the Hosts section. */
export const VaultIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M3 9.5h18" />
    <path d="M3 15h18" />
    <circle cx="7" cy="6.25" r="0.6" fill="currentColor" />
    <circle cx="7" cy="12.25" r="0.6" fill="currentColor" />
    <circle cx="7" cy="18" r="0.6" fill="currentColor" />
  </Svg>
);

export const GroupIcon = (p) => (
  <Svg {...p}>
    <path d="M3 7.5a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </Svg>
);

export const KeyIcon = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.85 12.15L19 4" />
    <path d="M15 8l3 3" />
    <path d="M17 6l2 2" />
  </Svg>
);

export const ForwardIcon = (p) => (
  <Svg {...p}>
    <path d="M4 8h13" />
    <path d="M14 4l4 4-4 4" />
    <path d="M20 16H7" />
    <path d="M10 12l-4 4 4 4" />
  </Svg>
);

export const SnippetIcon = (p) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M7.5 10l2.5 2-2.5 2" />
    <path d="M12.5 14.5h4" />
  </Svg>
);

export const SettingsIcon = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
  </Svg>
);

export const TerminalIcon = (p) => (
  <Svg {...p}>
    <polyline points="5 16 10 11 5 6" />
    <line x1="12" y1="18" x2="19" y2="18" />
  </Svg>
);

export const FolderIcon = (p) => (
  <Svg {...p}>
    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2v11z" />
  </Svg>
);

export const MenuIcon = (p) => (
  <Svg {...p}>
    <line x1="4" y1="7" x2="20" y2="7" />
    <line x1="4" y1="12" x2="20" y2="12" />
    <line x1="4" y1="17" x2="20" y2="17" />
  </Svg>
);

export const PlusIcon = (p) => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
);

export const CloseIcon = (p) => (
  <Svg {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="6" y1="18" x2="18" y2="6" />
  </Svg>
);

export const SearchIcon = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="20" y1="20" x2="16.2" y2="16.2" />
  </Svg>
);

export const ChevronDownIcon = (p) => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
);

export const ChevronRightIcon = (p) => (
  <Svg {...p}>
    <polyline points="9 6 15 12 9 18" />
  </Svg>
);

export const PencilIcon = (p) => (
  <Svg {...p}>
    <path d="M16.5 3.5a2.12 2.12 0 013 3L8 18l-4 1 1-4z" />
  </Svg>
);

export const GridIcon = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
  </Svg>
);

export const ListIcon = (p) => (
  <Svg {...p}>
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <line x1="4.5" y1="6" x2="4.51" y2="6" />
    <line x1="4.5" y1="12" x2="4.51" y2="12" />
    <line x1="4.5" y1="18" x2="4.51" y2="18" />
  </Svg>
);

export const CopyIcon = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </Svg>
);

export const TrashIcon = (p) => (
  <Svg {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </Svg>
);

export const SessionIcon = (p) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </Svg>
);

export const BroadcastIcon = (p) => (
  <Svg {...p}>
    <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
    <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4" />
    <circle cx="12" cy="12" r="2" />
    <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4" />
    <path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1" />
  </Svg>
);

/* Known Hosts: a fingerprint, drawn as nested arcs. */
export const FingerprintIcon = (p) => (
  <Svg {...p}>
    <path d="M12 11c0 3.5-1 6.5-2.8 9" />
    <path d="M8.4 8.6A4.5 4.5 0 0116.5 11c0 1.2-.1 2.4-.3 3.5" />
    <path d="M15.4 17.7c-.3 1-.7 2-1.2 2.9" />
    <path d="M5.2 15.5c.5-1.4.8-2.9.8-4.5a6 6 0 011.1-3.5" />
    <path d="M9 4.8A8 8 0 0120 11c0 1.8-.2 3.6-.6 5.3" />
    <path d="M3.6 12.5c.3-.5.4-1 .4-1.5a8 8 0 011.2-4.2" />
    <path d="M12.3 14.5c-.2 2.1-.8 4.1-1.8 5.9" />
  </Svg>
);

/* Logs: a clock. */
export const ClockIcon = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </Svg>
);

/* Saved / not saved in the Logs table. `filled` paints the ribbon. */
export const BookmarkIcon = ({ filled = false, ...p }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M6.5 3.5h11a1 1 0 011 1V21l-6.5-4.5L5.5 21V4.5a1 1 0 011-1z" />
  </Svg>
);

/* Import: an arrow into a tray. */
export const ImportIcon = (p) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <polyline points="7.5 10.5 12 15 16.5 10.5" />
    <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
  </Svg>
);

/* Warning triangle for the changed-host-key dialog. */
export const AlertIcon = (p) => (
  <Svg {...p}>
    <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Svg>
);

/* ─── View options toolbar (Hosts, Port Forwarding, Known Hosts) ─── */
export const TagIcon = (p) => (
  <Svg {...p}>
    <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8z" />
    <line x1="7.5" y1="7.5" x2="7.51" y2="7.5" />
  </Svg>
);

/* Two arrows, up and down */
export const SortIcon = (p) => (
  <Svg {...p}>
    <path d="M7 4v16" />
    <path d="M3.5 7.5L7 4l3.5 3.5" />
    <path d="M17 20V4" />
    <path d="M13.5 16.5L17 20l3.5-3.5" />
  </Svg>
);

export const CheckIcon = (p) => (
  <Svg {...p}>
    <polyline points="4.5 12.5 9.5 17.5 19.5 6.5" />
  </Svg>
);

export const PlayIcon = (p) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </Svg>
);

export const StopIcon = (p) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
  </Svg>
);

/* Mobile layout (Android): top bars, overflow menus, the extra-keys row. */
export const ArrowLeftIcon = (p) => (
  <Svg {...p}>
    <line x1="19" y1="12" x2="5" y2="12" />
    <polyline points="12 19 5 12 12 5" />
  </Svg>
);

export const MoreVerticalIcon = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="5.5" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="18.5" r="1.2" fill="currentColor" />
  </Svg>
);

export const MoreHorizontalIcon = (p) => (
  <Svg {...p}>
    <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
  </Svg>
);

export const PasteIcon = (p) => (
  <Svg {...p}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4.5V3.5a1 1 0 011-1h4a1 1 0 011 1v1" />
    <line x1="9" y1="11" x2="15" y2="11" />
    <line x1="9" y1="15" x2="13" y2="15" />
  </Svg>
);
