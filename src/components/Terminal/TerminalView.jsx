import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../contexts/AppContext';
import { getTheme } from '../../themes/terminal-themes';
import { tintTheme } from '../../themes/tint';
import { tabColor } from '../HostList/hostColor';
import { paneTitle, groupOf, focusedPaneOf } from '../SplitPane/layoutTree';
import { IS_ANDROID, IS_WEB, PLATFORM, FEATURES } from '../../platform';
import ExtraKeys, { useStickyModifiers } from './mobile/ExtraKeys';
import SessionHeader from './mobile/SessionHeader';
import { applyModifiers, keySequence } from './mobile/keys';
import { attachTouch, readPinchedFont, writePinchedFont, FONT_EVENT } from './mobile/touch';
import { pasteInto, copySelection, writeText as writeClipboardText } from './clipboardPaste';
import { sessionStatus } from '../Mobile/sessions';
import { liveSessionId } from '../SplitPane/sessions';
import { registerTerminal, adoptedReady } from '../SplitPane/windowMove';
import { extractReply, talkPasteText } from './agentTalkText';
import { playChime, playQuestionChime, TYPING_QUIET_MS } from './agentChime';
import { detectAgent, screenTail, createAgentTracker, NEEDS_YOU_TEXT, parseChoices, cursorRowText, claudeSuggestion, screenCells, talkInputAt, screenRows } from './agentRules';
import PromptActions from '../Agents/PromptActions';
import './TerminalView.css';
import '../Keeper/Keeper.css';
import { showToast } from '../Keeper/toast';
import { attachImages, canAttach, isFilesDrag } from './imageAttach';
import Composer, { ComposeButton } from './Composer';
import { isWebAppShortcut } from '../Web/webKeys';
import { attachPathLinks } from './pathLinkProvider';
import { terminalFontFamily } from './fontStack';

const hasApi = () => typeof window !== 'undefined' && !!window.electronAPI;

export default function TerminalView({ tab }) {
  const { state, dispatch, actions } = useApp();
  const termRef = useRef(null);
  const containerRef = useRef(null);
  const fitAddonRef = useRef(null);
  const searchAddonRef = useRef(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [connected, setConnected] = useState(false);
  /* For the snapshot a move to another window takes (windowMove.js) */
  const connectedRef = useRef(false);
  connectedRef.current = connected;
  const initializedRef = useRef(false);
  const sessionIdRef = useRef(null);
  const mountedRef = useRef(true);
  const [isLogging, setIsLogging] = useState(false);
  const logBufferRef = useRef([]);
  const isLoggingRef = useRef(false);
  const activeTabIdRef = useRef(state.activeTabId);
  const broadcastRef = useRef(state.broadcast);
  const tabsRef = useRef(state.tabs);
  /* Android: sticky Ctrl/Alt from the extra-keys row modify what the soft
     keyboard types; keys the row itself sends skip that (bypassRef). */
  const modifiers = useStickyModifiers();
  const inputFilterRef = useRef(null);
  const bypassRef = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  /* "Copied" hint on the pane (time of the last copy; 0 = hidden) */
  const [copiedAt, setCopiedAt] = useState(0);
  /* Web: an OSC 52 copy the browser refused (no user gesture), waiting for
     a click on the "Click to copy" hint ({ text, at }) */
  const [clickToCopy, setClickToCopy] = useState(null);
  /* A multi-line paste waiting for "Paste N lines?" ({ lines, resolve }) */
  const [pasteAsk, setPasteAsk] = useState(null);
  const askPasteRef = useRef(null);
  /* SEAM for image paste: set pasteImageRef.current = ({ png, mime }) => ...
     and every paste entry point (keys, right-click, Android button) hands it
     a clipboard that has an image and no text (clipboardPaste.pasteInto). */
  const pasteImageRef = useRef(null);
  /* Images dropped/pasted into this pane (imageAttach.js): the status line
     ("Uploading x.png… 60%", or an error) and the dragover highlight */
  const [attachStatus, setAttachStatus] = useState(null);
  const [fileOver, setFileOver] = useState(false);
  const attachTimerRef = useRef(null);
  const showAttachStatus = (st) => {
    clearTimeout(attachTimerRef.current);
    if (!mountedRef.current) return;
    setAttachStatus(st);
    if (st && st.kind === 'error') attachTimerRef.current = setTimeout(() => setAttachStatus(null), 6000);
  };
  const attachRef = useRef(null);
  /* Attached paths go to THIS session only, never broadcast: term.paste
     fires onData synchronously, and onData skips the broadcast while this
     flag is up (the paste keeps bracketed-paste markers if the program
     asked for them). A path of this computer/server means nothing to the
     other sessions. */
  const noBroadcastRef = useRef(false);
  /* Agent to agent (agent-talk): send/read/watch of the live terminal, set in the effect */
  const talkRef = useRef(null);
  const pasteHereOnly = (text) => {
    const t = termRef.current;
    if (!t) return;
    noBroadcastRef.current = true;
    try { t.paste(text); } finally { noBroadcastRef.current = false; }
  };
  /* Quick answers (Agents/PromptActions): the options of the prompt the
     agent is blocked on, parsed at each scan. After a click they stay hidden
     until a scan finds no prompt (the next prompt shows them again). The
     keys go to THIS session only, like an attached path (no broadcast), and
     skip Android's sticky Ctrl/Alt (bypassRef). */
  const [choices, setChoices] = useState(null);
  const choicesKeyRef = useRef('null');
  const answeredRef = useRef(false);
  const showChoices = (list) => {
    if (!list.length) answeredRef.current = false;
    const next = answeredRef.current || !list.length ? null : list;
    const key = JSON.stringify(next);
    if (key === choicesKeyRef.current) return;
    choicesKeyRef.current = key;
    setChoices(next);
  };
  const answerPrompt = (choice, { keepFocus = false } = {}) => {
    const t = termRef.current;
    if (!t || !choice) return;
    answeredRef.current = true;
    choicesKeyRef.current = 'null';
    setChoices(null);
    noBroadcastRef.current = true;
    bypassRef.current = true;
    try { t.input(choice.keys, true); } finally { noBroadcastRef.current = false; bypassRef.current = false; }
    if (!IS_ANDROID && !keepFocus) t.focus();
  };
  /* The composer's text as the answer to an option that takes text
     (choice.textKeys, agentRules.freeTextOption): the keys that open its
     field, then the text as one paste, then Enter. Separate writes with a
     pause, as verified live: Ink has to redraw the field before the paste. */
  const answerWithText = (choice, text, enter) => {
    const t = termRef.current;
    if (!t || !choice || typeof choice.textKeys !== 'string') return false;
    if (hasApi() && !sessionIdRef.current) return false;
    answeredRef.current = true;
    choicesKeyRef.current = 'null';
    setChoices(null);
    const here = (fn) => {
      if (termRef.current !== t) return;
      noBroadcastRef.current = true;
      bypassRef.current = true;
      try { fn(); } finally { noBroadcastRef.current = false; bypassRef.current = false; }
    };
    if (choice.textKeys) here(() => t.input(choice.textKeys, true));
    setTimeout(() => {
      here(() => t.paste(text));
      if (enter) setTimeout(() => here(() => t.input('\r', true)), 150);
    }, choice.textKeys ? 200 : 0);
    return true;
  };
  /* Claude Code's suggested next prompt (agentRules.claudeSuggestion), for
     the composer's ghost text. Re-read at every scan. */
  const [suggestion, setSuggestion] = useState('');
  const suggestionRef = useRef('');
  const showSuggestion = (text) => {
    if (text === suggestionRef.current) return;
    suggestionRef.current = text;
    setSuggestion(text);
  };
  attachRef.current = (items) => attachImages(termRef.current, tabLiveRef.current, items, { onStatus: showAttachStatus, paste: pasteHereOnly });
  useEffect(() => () => clearTimeout(attachTimerRef.current), []);
  /* Prompt composer (Composer.jsx): open/closed, and a counter whose every
     change gives it the keyboard (Ctrl+Shift+E from the terminal) */
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeFocus, setComposeFocus] = useState(0);
  const composeKeyRef = useRef(null);
  composeKeyRef.current = () => { setComposeOpen(true); setComposeFocus(n => n + 1); };
  /* A clipboard image (no text) from any paste entry point → attached like a
     dropped file: saved/uploaded, its path typed. Desktop only. */
  pasteImageRef.current = (!IS_ANDROID && canAttach()) ? (img) => attachRef.current([img]) : null;
  /* A tab reopened from Sessions → Background whose session turned out to
     be gone: close it and say so (main has dropped the record already) */
  const goneFromBackground = () => {
    actions.removeTab(tab.id);
    showToast('That session has ended');
  };
  inputFilterRef.current = IS_ANDROID ? (data) => {
    if (bypassRef.current) return data;
    const mods = modifiers.peek();
    if (!mods.ctrl && !mods.alt) return data;
    const r = applyModifiers(data, mods);
    if (r.used) modifiers.spend();
    return r.data;
  } : null;

  /* Keep broadcast & tabs refs in sync with state */
  useEffect(() => { broadcastRef.current = state.broadcast; }, [state.broadcast]);
  useEffect(() => { tabsRef.current = state.tabs; }, [state.tabs]);

  const isLocal = tab.type === 'local-terminal';
  /* Web mirror: this pane shows a session of the PC (its live id from
     mirror:state). It never connects or spawns: it joins (see below). */
  const mirrorSid = IS_WEB && tab.mirror ? liveSessionId(tab) : null;
  /* …and joins again when the socket comes back (a new client for main) */
  const mirrorKey = mirrorSid ? `${mirrorSid}#${state.mirrorEpoch || 0}` : null;

  /* Terminal settings from app */
  const termSettings = state.settings?.terminal || {};
  const termSettingsRef = useRef(termSettings);
  termSettingsRef.current = termSettings;
  /* The tab as it is now (alias, mute), for listeners set up once */
  const tabLiveRef = useRef(tab);
  tabLiveRef.current = tab;
  /* Is the user looking at this pane right now (for the "needs you" alert) */
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastSettingsFontRef = useRef(undefined);

  /* The scheme, with this terminal's colour (if any) mixed into its
     background (themes/tint.js; memoised, so the same object every render
     until the scheme or the colour changes). Applied live below: no xterm is
     ever re-created for it. */
  const theme = tintTheme(getTheme(termSettings.theme || 'github-dark'), tabColor(tab, state.hosts));
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    /* For SSH tabs: wait until sessionId is available (connecting is done) */
    if (!isLocal && tab.connecting) return;
    if (!isLocal && !tab.sessionId) return;
    /* A mirrored pane: until the PC's session exists (a pty being spawned) */
    if (IS_WEB && tab.mirror && !mirrorSid) return;
    if (initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;
    mountedRef.current = true;
    /* This run's cleanup happened (pane closed, or StrictMode's remount) */
    let disposed = false;
    /* ssh:reconnect listener of this run (SSH tabs), removed on cleanup */
    let reconnectListener = null;
    /* Moved in from another window: its screen (serialized there), written
       into this new xterm before anything else; then main is told to hand the
       session's output over (windowMove.js). Same geometry as the source until
       that is done, then a normal fit. */
    const adopt = tab.adopt && tab.adopt.moveId ? tab.adopt : null;
    const adoptSize = adopt && adopt.cols > 0 && adopt.rows > 0 ? { cols: adopt.cols, rows: adopt.rows } : {};

    const term = new Terminal({
      ...adoptSize,
      fontFamily: terminalFontFamily(termSettings.fontFamily),
      fontSize: (IS_ANDROID && readPinchedFont()) || termSettings.fontSize || 14,
      cursorStyle: termSettings.cursorStyle || 'block',
      cursorBlink: true,
      scrollback: termSettings.scrollback || 5000,
      theme: themeRef.current,
      allowProposedApi: true,
      /* xterm's default on macOS: a right-click first selects the word under
         it, so right-click "paste" copied that word instead */
      rightClickSelectsWord: false,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    const serializeAddon = new SerializeAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(serializeAddon);

    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    termRef.current = term;

    term.open(containerRef.current);

    /* Character widths as the shell counts them. xterm's default table is
       Unicode 6, where most emoji (🚀 ✅ ⚡ 🦀, prompt themes, CLI output) are
       one cell; glibc/macOS wcwidth say two. Every such character put the
       cursor one column off the shell's idea of it: typed text and redraws
       landed in the wrong column. */
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
    } catch (e) { /* stays on 6 */ }

    /* ─── Size reported to the pty ───
       Only a terminal that is laid out has a size: a hidden tab
       (display:none) would report xterm's 80x24 placeholder, the shell would
       redraw its prompt for that width, and the wider xterm would show it
       over the lines above. So: measure first, report only real sizes, and
       report each size once. */
    const laidOut = () => {
      try {
        const d = fitAddon.proposeDimensions();
        return !!d && Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 0 && d.rows > 0;
      } catch (e) { return false; }
    };
    let lastSentSize = '';
    let sendSize = null;   // set once the session can take it
    /* Another client (a viewer, window-registry.js) conducts this session's
       size: {cols, rows} the pty has, which this xterm follows until the
       user types here again. Null: this pane's own fit rules. */
    let follow = null;
    const pushSize = (force = false) => {
      if (!sendSize || disposed || !laidOut()) return;
      /* Following the conductor: its size is not ours to report */
      if (follow && term.cols === follow.cols && term.rows === follow.rows) return;
      const key = `${term.cols}x${term.rows}`;
      if (!force && key === lastSentSize) return;
      lastSentSize = key;
      sendSize(term.cols, term.rows);
    };
    /* Resolves once the pane has a size (a hidden tab: when it is shown) */
    let layoutWait = null;
    const whenLaidOut = () => new Promise((resolve) => {
      if (laidOut()) { resolve(); return; }
      layoutWait = new ResizeObserver(() => {
        if (disposed || !laidOut()) return;
        layoutWait.disconnect();
        layoutWait = null;
        resolve();
      });
      layoutWait.observe(containerRef.current);
    });

    /* File paths in the output: Ctrl/Cmd+click opens, right-click menu (pathLinkProvider.js) */
    const detachPaths = IS_ANDROID ? () => {} : attachPathLinks(term, containerRef.current, {
      target: () => ({ kind: isLocal ? 'local' : 'ssh', sessionId: sessionIdRef.current, owner: `term-${String(tab.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 90)}`, label: tabLiveRef.current?.label }),
      openSftpAt: (dir) => {
        const h = isLocal ? null : stateRef.current.hosts.find(x => x.id === tab.hostId);
        if (!isLocal && !h) { showToast('This terminal has no saved host to open in SFTP'); return; }
        actions.openSFTPTab(h, isLocal ? { localPath: dir } : { path: dir });
      },
    });

    /* The adopted screen first; it resolves once xterm has parsed it */
    const restored = adopt && adopt.data
      ? new Promise((resolve) => term.write(adopt.data, resolve))
      : Promise.resolve();
    /* Moving this tab to another window: the screen as it is now, after
       everything already received has been parsed (write('') resolves once
       the queue before it is done). */
    const unregister = registerTerminal(tab.id, {
      snapshot: () => new Promise((resolve) => term.write('', resolve)).then(() => ({
        data: serializeAddon.serialize({ scrollback: term.options.scrollback }),
        cols: term.cols,
        rows: term.rows,
        connected: connectedRef.current,
      })),
      /* Another client joins this session: serialized IN the callback, so
         nothing that arrives after the request is in it (main buffers that
         for the viewer). A .then() would run after xterm parsed more. */
      snapshotAt: () => new Promise((resolve, reject) => term.write('', () => {
        try {
          resolve({
            data: serializeAddon.serialize({ scrollback: term.options.scrollback }),
            cols: term.cols,
            rows: term.rows,
            connected: connectedRef.current,
          });
        } catch (err) { reject(err); }
      })),
      sessionId: () => sessionIdRef.current || null,
      /* Agent to agent: set further down, once the agent tracker exists */
      talk: () => talkRef.current,
    });
    /* The pty's size changed because another client conducts it: this xterm
       follows, without refitting (that would fight it). The next key typed
       here makes this client the conductor again (main applies its size) and
       the pane fits itself back. */
    const sizeListener = window.electronAPI?.session?.onSize?.((p) => {
      if (disposed || !p || p.sessionId !== sessionIdRef.current) return;
      /* release: this pane conducts again (the conductor left, or nobody
         else shows the session). Stop following and fit back to the pane. */
      if (p.release) {
        follow = null;
        try { fitAddon.fit(); } catch (_) { /* not laid out */ }
        pushSize();
        return;
      }
      const { cols, rows } = p;
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
      if (cols === term.cols && rows === term.rows) { follow = null; return; }
      follow = { cols, rows };
      try { term.resize(cols, rows); } catch (_) { /* disposed */ }
    }) || null;
    /* OSC 52 copies apply only in the client that typed last in this
       session (main: 'session:conductor'), so the PC and a browser never
       fight over the clipboard. A browser pane joins as a viewer: the PC
       conducts until the browser types. Typing or clicking here takes it
       back at once (main agrees as soon as the input arrives). */
    let conducting = !(IS_WEB && tab.mirror);
    const conductorListener = window.electronAPI?.session?.onConductor?.((p) => {
      if (disposed || !p || p.sessionId !== sessionIdRef.current) return;
      conducting = !!p.conducting;
    }) || null;
    const followKey = term.onKey(() => {
      if (!follow) return;
      follow = null;
      try { fitAddon.fit(); } catch (_) { /* not laid out */ }
      pushSize(true);
    });

    /* ─── Attention: bell mark, agent chime, desktop notification ───
       Agent CLIs (Claude Code, Codex...) end a turn with BEL or a
       notification escape (OSC 9 / 777 notify / 99). Either plays the chime
       unless muted (Settings → Terminal, or this terminal's own mute); a
       plain BEL right after typing is the shell complaining and only marks
       the tab, as before. When the window is not focused a desktop
       notification says which terminal it was. */
    let lastTyped = 0;
    /* A message another agent sent (agent-talk, below) is being typed: that
       is not the user typing, so a bell right after it is the agent, not a
       shell complaining */
    let talkInjecting = false;
    const talkWatches = new Map();   // deliveryId -> {marker, text, emit, armed, check}
    /* Focusing or typing in a pane is looking at it: its "done" mark goes.
       From the textarea's own focus/keydown, NOT onData: xterm also emits
       onData by itself (focus reports \e[I/\e[O, cursor-position and DA
       replies a TUI asks for while redrawing), which would clear the mark
       of a pane nobody looked at. */
    const seen = () => {
      const live = tabLiveRef.current || tab;
      if (live.doneAt) dispatch({ type: 'PANE_SEEN', payload: live.id });
    };
    term.onData(() => { if (!talkInjecting) lastTyped = Date.now(); });
    if (term.textarea) {
      term.textarea.addEventListener('focus', seen);
      term.textarea.addEventListener('keydown', seen);
    }
    /* A click on a desktop notification: raise this window (main does it:
       window.focus() from the page does not on Linux), open the tab and give
       this pane the keyboard */
    const showThisPane = () => {
      const id = (tabLiveRef.current || tab).id;
      const w = FEATURES.multiWindow && window.electronAPI && window.electronAPI.window;
      if (w && w.info && w.focusAgent) {
        w.info().then((me) => me && w.focusAgent({ windowId: me.id, tabId: id })).catch(() => {});
      } else {
        try { window.focus(); } catch (_) { /* nothing to raise */ }
      }
      const g = groupOf(stateRef.current, id);
      dispatch({ type: 'SET_ACTIVE_TAB', payload: g || id });
      if (g) dispatch({ type: 'PANE_FOCUS', payload: { groupId: g, paneId: id } });
      requestAnimationFrame(() => { if (!disposed && term.textarea) term.textarea.focus({ preventScroll: true }); });
    };
    const paneLabel = (live) => (live.alias ? `${live.alias} · ${live.label || 'Terminal'}` : (live.label || 'Terminal'));
    /* An agent finished: the pane glows, its tab gets the done badge, the
       taskbar flashes (Settings → Terminal → Visual Alerts; a muted terminal
       still shows them, muting is about sound). The reducer skips the pane
       the user is looking at. Visual alerts off: the old bell mark. */
    const finished = (message) => {
      const live = tabLiveRef.current || tab;
      const ts = termSettingsRef.current || {};
      if (ts.visualAlerts !== false) {
        dispatch({ type: 'PANE_DONE', payload: { id: live.id, windowFocused: document.hasFocus(), at: Date.now() } });
      } else if (live.id !== activeTabIdRef.current) {
        dispatch({ type: 'TAB_NOTIFY', payload: live.id });
      }
      if (ts.agentSound !== false && !live.muted) playChime();
      if (ts.agentNotify !== false && !document.hasFocus() && typeof Notification !== 'undefined') {
        try { new Notification(paneLabel(live), { body: message || 'Finished', silent: true }).onclick = showThisPane; } catch (_) { /* not allowed */ }
      }
    };

    /* ─── Agent state: which agent CLI runs here and what it is doing ───
       The bottom rows of the screen are read ~300 ms after output settles
       (and every 1.5 s while it keeps flowing: a spinner never settles) and
       matched against agentRules.js. Only changes are dispatched (the
       tracker compares). working → idle prompt after >= 3 s is "finished",
       for agents that ring no bell; a permission prompt or y/n question is
       "needs you": amber instead of green, its own chime, its own notice. */
    const tracker = createAgentTracker(tab.agent || null);
    let lastKey = 0;
    const onKey = () => { lastKey = Date.now(); };
    const publish = (agent) => {
      const live = tabLiveRef.current || tab;
      dispatch({ type: 'AGENT_STATE', payload: { id: live.id, agent } });
    };
    /* The focused pane of the tab on screen, in a focused, visible window */
    const lookingAt = () => {
      if (!document.hasFocus() || document.visibilityState === 'hidden') return false;
      const st = stateRef.current;
      const id = (tabLiveRef.current || tab).id;
      const g = groupOf(st, id);
      return !!g && g === st.activeTabId && focusedPaneOf(st, g) === id;
    };
    const needsYou = (agent) => {
      const live = tabLiveRef.current || tab;
      const ts = termSettingsRef.current || {};
      if (ts.visualAlerts !== false) {
        dispatch({ type: 'PANE_DONE', payload: { id: live.id, windowFocused: document.hasFocus(), at: Date.now(), kind: 'blocked' } });
      }
      if (lookingAt()) return;
      if (ts.agentSound !== false && !live.muted) playQuestionChime();
      if (ts.agentNotify !== false && !document.hasFocus() && typeof Notification !== 'undefined') {
        const who = agent && agent.name ? agent.name : 'The agent';
        try { new Notification(`${paneLabel(live)} needs your input`, { body: `${who} is waiting for you`, silent: true }).onclick = showThisPane; } catch (_) { /* not allowed */ }
      }
    };
    const runScan = () => {
      if (disposed) return null;
      const prev = tracker.get();
      const prevState = prev ? prev.state : null;
      const r = tracker.scan(detectAgent(screenTail(term), prev && prev.id), Date.now(),
        { typedRecently: Date.now() - lastKey < TYPING_QUIET_MS });
      if (r.changed) publish(r.agent);
      /* A message from another agent waits for this turn to end: a short
         turn (working → prompt in < 3 s) ends with no 'done' event */
      if (talkWatches.size) {
        if (r.event === 'blocked') talkTurn('blocked');
        else if (r.event === 'done' || (r.changed && prevState === 'working' && r.agent && r.agent.state === 'idle')) talkTurn('done');
      }
      /* An agent's menu only while it is blocked; a shell question ([Y/n])
         only with no agent, and only on the cursor's row */
      const a = r.agent;
      showChoices(!a ? parseChoices(screenTail(term), null, { cursorLine: cursorRowText(term) })
        : a.state === 'blocked' ? parseChoices(screenTail(term), a.id) : []);
      showSuggestion(a && a.id === 'claude' && (a.state === 'idle' || a.state === 'done')
        ? claudeSuggestion(screenCells(term)) : '');
      if (r.event === 'blocked') needsYou(r.agent);
      else if (r.event === 'done') finished(`${r.agent.name} finished`);
      return r;
    };
    if (term.textarea) term.textarea.addEventListener('keydown', onKey);
    const SCAN_QUIET_MS = 300;
    const SCAN_MAX_MS = 1500;
    let scanTimer = null;
    let pendingSince = 0;
    term.onWriteParsed(() => {
      const now = Date.now();
      if (!pendingSince) pendingSince = now;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => { pendingSince = 0; scanTimer = null; runScan(); },
        Math.max(0, Math.min(SCAN_QUIET_MS, pendingSince + SCAN_MAX_MS - now)));
    });

    /* BEL / OSC notification. A plain BEL right after typing is the shell
       complaining: only the bell mark. Otherwise the screen gets a moment to
       settle (the notification often comes with the prompt it is about):
       a permission prompt on screen, or a "needs your permission" text, is
       "needs you"; anything else is "finished", the strongest signal. */
    const attention = (kind, message) => {
      const live = tabLiveRef.current || tab;
      const complaint = kind === 'bell' && Date.now() - lastTyped < TYPING_QUIET_MS;
      if (complaint) {
        if (live.id !== activeTabIdRef.current) dispatch({ type: 'TAB_NOTIFY', payload: live.id });
        return;
      }
      setTimeout(() => {
        if (disposed) return;
        const r = runScan();
        if (talkWatches.size) {
          const now = tracker.get();
          talkTurn(now && now.state === 'blocked' ? 'blocked' : 'done');
        }
        if (r && r.event) return;   // that scan already announced it
        const cur = tracker.get();
        if ((cur && cur.state === 'blocked') || NEEDS_YOU_TEXT.test(message || '')) {
          needsYou(cur);
          return;
        }
        /* Announced a moment ago by the working → prompt transition */
        if (cur && cur.state === 'done' && Date.now() - cur.since < 5000) return;
        const d = tracker.oscDone(Date.now());
        if (d.changed) publish(d.agent);
        finished(message);
      }, 150);
    };
    /* ─── Agent to agent (electron/agent/agent-talk.js) ───
       Main asks THIS window (it owns the session) to type another agent's
       message, exactly like the Composer: one paste (bracketed when the
       program asked for it), then Enter as its own key, never broadcast.
       A marker on the cursor's line says where the answer starts; the end
       of the turn (bell / OSC, or working → idle prompt) is reported with
       the new text under it. After a turn end the screen gets TALK_GRACE_MS:
       an agent that picks up a queued message is working again by then, and
       that was not our turn yet.
       Main sends one message per terminal at a time (its queue); if a caller
       gave up early there can be more than one here: each turn end goes to
       the OLDEST armed watch only, in order, and none is ever dropped.
       Typed only with the cursor IN the agent's input field (talkInputAt):
       a screen that merely looks like an agent (an exited Claude's box, a
       `cat` of its footer) is refused, nothing is typed. */
    const TALK_GRACE_MS = 1200;
    /* The buffer's logical lines from the marker (TALK_ABOVE rows over the
       cursor's line when the message was typed), and where that line is */
    const TALK_ABOVE = 20;
    const talkLines = (w) => {
      const b = term.buffer.active;
      const useMarker = w && w.marker && !w.marker.isDisposed && w.marker.line >= 0 && b.type !== 'alternate';
      const from = useMarker ? w.marker.line : 0;
      const lines = [];
      let near = null;
      for (let y = from; y < b.length; y++) {
        const line = b.getLine(y);
        if (!line) continue;
        const str = line.translateToString(true);
        if (line.isWrapped && lines.length) lines[lines.length - 1] += str;
        else lines.push(str);
        if (useMarker && y === from + w.above) near = lines.length - 1;
      }
      return { lines, near };
    };
    const talkText = (w, text) => {
      const a = tracker.get();
      const { lines, near } = talkLines(w);
      return extractReply(lines, { text: text || (w && w.text) || '', agentId: a ? a.id : null, near });
    };
    const talkDrop = (id) => {
      const w = talkWatches.get(id);
      if (!w) return;
      clearTimeout(w.check);
      try { if (w.marker) w.marker.dispose(); } catch (_) { /* gone */ }
      talkWatches.delete(id);
    };
    const talkEmit = (id, event) => {
      const w = talkWatches.get(id);
      if (!w) return;
      const t = talkText(w);
      talkDrop(id);
      w.emit(id, { event, reply: t.reply, truncated: t.truncated });
    };
    function talkTurn(kind) {
      let id = null;
      let w = null;
      for (const [k, v] of talkWatches) if (v.armed) { id = k; w = v; break; }
      if (!w) return;
      if (kind === 'blocked') { talkEmit(id, 'blocked'); return; }
      if (w.check) return;
      w.check = setTimeout(() => {
        w.check = null;
        if (disposed || !talkWatches.has(id)) return;
        runScan();
        const a = tracker.get();
        /* Working again: a message queued in the agent started. With another
           of ours behind this one that is ours, and this turn did end. */
        let armed = 0;
        for (const v of talkWatches.values()) if (v.armed) armed++;
        if (a && a.state === 'working' && armed < 2) return;   // the user's queued message: not ours yet
        talkEmit(id, a && a.state === 'blocked' ? 'blocked' : 'done');
      }, TALK_GRACE_MS);
    }
    const talkType = (fn) => {
      noBroadcastRef.current = true;
      bypassRef.current = true;
      talkInjecting = true;
      try { fn(); } finally { noBroadcastRef.current = false; bypassRef.current = false; talkInjecting = false; }
    };
    const talk = {
      send: (text, id, emit) => {
        if (disposed) return { ok: false, code: 'unreachable', error: 'That terminal is closing.' };
        if (hasApi() && !sessionIdRef.current) return { ok: false, code: 'unreachable', error: 'That terminal is not connected.' };
        const live = tabLiveRef.current || tab;
        if (live.talkBlocked) return { ok: false, code: 'blocked', error: 'The user does not let agents message this session.' };
        runScan();
        const a = tracker.get();
        if (!a) return { ok: false, code: 'not-agent', error: 'No agent CLI is running in that terminal now (it looks like a plain shell). Nothing was sent.' };
        if (a.state === 'blocked') return { ok: false, code: 'busy', error: 'That session is waiting for the user (a permission prompt or a question). Nothing was sent.' };
        if (typeof text !== 'string' || !text || typeof id !== 'string') return { ok: false, error: 'Nothing to send.' };
        /* The cursor must be in the agent's input field, not just its box on screen */
        const scr = screenRows(term);
        const at = talkInputAt(scr.rows, scr.cursorY, a.id, scr.cursorX);
        if (!at.ok) return { ok: false, code: 'not-agent', error: `No agent CLI is waiting for input in that terminal now (${at.reason}). Nothing was sent.` };
        /* Main sanitised it already; again here, and on one line without bracketed paste */
        const typed = talkPasteText(text, !!(term.modes && term.modes.bracketedPasteMode));
        if (!typed.trim()) return { ok: false, error: 'Nothing to send.' };
        let marker = null;
        const buf = term.buffer.active;
        const above = Math.min(TALK_ABOVE, buf.baseY + buf.cursorY);
        try { marker = term.registerMarker(-above); } catch (_) { marker = null; }
        const w = { marker, above, text: typed, emit, armed: false, check: null };
        talkWatches.set(id, w);
        talkType(() => term.paste(typed));
        setTimeout(() => {
          if (disposed || termRef.current !== term) return;
          talkType(() => term.input('\r', true));
          w.armed = true;
        }, 120);
        return { ok: true, state: a.state };
      },
      read: (id, text) => {
        const t = talkText(talkWatches.get(id) || null, text);
        const a = tracker.get();
        return { reply: t.reply, truncated: t.truncated, state: a ? a.state : null };
      },
      watch: (id, text, emit) => {
        if (!talkWatches.has(id)) talkWatches.set(id, { marker: null, above: 0, text, emit, armed: true, check: null });
        return { ok: true };
      },
    };
    talkRef.current = talk;

    term.onBell(() => attention('bell'));
    const oscText = (data) => (data || '').slice(0, 200);
    term.parser.registerOscHandler(9, (data) => {
      // OSC 9;4;... is ConEmu progress, not a notification
      if (!/^4;/.test(data)) attention('osc', oscText(data));
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const [cmd, title, body] = (data || '').split(';');
      if (cmd === 'notify') attention('osc', oscText(body || title));
      return true;
    });
    term.parser.registerOscHandler(99, (data) => {
      const body = (data || '').split(';').slice(1).join(';');
      attention('osc', oscText(body));
      return true;
    });

    /* OSC 52: programs that draw their own selection (Claude Code's
       full-screen UI, tmux, vim, neovim with clipboard=unnamedplus over ssh)
       copy by sending `ESC ] 52 ; <c|p|s…> ; <base64> BEL` to the terminal.
       Without this the copy never reached the system clipboard. Writes only:
       reading the clipboard back ('?') is refused — a remote program must
       never be able to read what the user copied elsewhere. */
    term.parser.registerOscHandler(52, (data) => {
      const i = (data || '').indexOf(';');
      if (i < 0) return true;
      const targets = data.slice(0, i) || 'c';
      const b64 = data.slice(i + 1);
      if (b64 === '?' || b64.length > 1400000) return true;
      let text = '';
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (_) { return true; }
      if (!text) return true;
      /* Another client (the PC, or a browser) typed last: the copy is its */
      if (!conducting) return true;
      const clipboard = /[cs0-7]/.test(targets) || !/p/.test(targets);
      const selection = /p/.test(targets);
      writeClipboardText(text, { clipboard, selection }).then((ok) => {
        if (disposed) return;
        if (ok) setCopiedAt(Date.now());
        /* A browser refuses writeText without a recent user gesture: offer a click */
        else if (IS_WEB && clipboard) setClickToCopy({ text, at: Date.now() });
      }).catch(() => {});
      return true;
    });

    /* ─── Copy / Paste ───
       All of it goes through clipboardPaste.js (Electron's clipboard in main
       on desktop: reliable whether or not the document has focus; the old
       navigator.clipboard path rejected then and pasted nothing, silently).
       Paste ends in term.paste(): bracketed paste when the program asked for
       it, newlines as CR, and onData, the same path as typing (right session
       id, broadcast, the input filter). Keys are matched by `code` so the
       layout and CapsLock don't matter. */
    const flashCopied = () => { if (!disposed) setCopiedAt(Date.now()); };
    const doCopy = () => {
      if (!term.hasSelection()) return false;
      copySelection(term).then((r) => { if (r.copied) flashCopied(); });
      term.clearSelection();
      return true;
    };
    const doPaste = (source = 'clipboard') => {
      pasteInto(term, {
        source,
        onImage: pasteImageRef.current || undefined,
        confirm: (termSettingsRef.current || {}).warnMultilinePaste === false ? undefined : (info) => askPasteRef.current(info),
      }).catch(() => {});
      term.focus();
    };
    /* Selecting is copying: Linux's PRIMARY always (what middle-click pastes
       everywhere), the clipboard too with Copy on Select (on by default).
       After the mouse is released, so a drag is copied once, at its end;
       on the document, since a drag may end outside the pane. */
    let lastSelected = '';
    let selecting = false;
    const onSelectStart = (e) => { conducting = true; if (e.button === 0) selecting = true; };
    const onSelectEnd = (e) => {
      if (e.button !== 0 || !selecting) return;
      selecting = false;
      setTimeout(() => {
        if (disposed || !term.hasSelection()) return;
        const onSelect = (termSettingsRef.current || {}).copyOnSelect !== false;
        if (!onSelect && (IS_WEB || PLATFORM !== 'linux')) return;
        const text = term.getSelection();
        if (!text || text === lastSelected) return;
        lastSelected = text;
        copySelection(term, { clipboard: onSelect, selection: true }).then((r) => { if (r.copied) flashCopied(); });
      }, 0);
    };
    term.onSelectionChange(() => { if (!term.hasSelection()) lastSelected = ''; });
    /* The program asked for the mouse (tmux, vim, htop with mouse on): clicks
       are its own unless Shift forces the terminal's (xterm's rule) */
    const mouseIsApps = (e) => term.modes && term.modes.mouseTrackingMode !== 'none' && !e.shiftKey;
    /* Right after a dead key (´ + space = ´, ´ + a = á) the default path is
       kept, so the composed character comes from the IME as usual. */
    let afterDeadKey = false;
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      conducting = true;
      if (ev.key === 'Dead') { afterDeadKey = true; return true; }
      /* Web: the app's Alt+Shift shortcuts (App.jsx) are not for the shell */
      if (IS_WEB && isWebAppShortcut(ev)) return false;
      /* Shift+Enter → ESC CR (Meta+Enter): a newline without sending in
         Claude Code, Codex and other agent prompts — what their own
         /terminal-setup configures in terminals that don't do it. */
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        term.input('\x1b\r', true);
        return false;
      }
      // Ctrl+Shift+E → the prompt composer (opens it, or gives it the keyboard)
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === 'KeyE') {
        ev.preventDefault();
        composeKeyRef.current();
        return false;
      }
      const wasDead = afterDeadKey;
      afterDeadKey = false;
      /* Copy / paste combos first: nothing below may ever swallow them */
      const ctrl = ev.ctrlKey || ev.metaKey;
      const insert = ev.code === 'Insert' || (ev.code === 'Numpad0' && ev.key === 'Insert');
      // Ctrl+Shift+C / Ctrl+Insert → copy the selection (Cmd+C on macOS)
      if ((ctrl && ev.shiftKey && !ev.altKey && ev.code === 'KeyC') || (ev.ctrlKey && !ev.shiftKey && !ev.altKey && insert)) {
        doCopy();
        ev.preventDefault();
        return false;
      }
      // Ctrl+C (Cmd+C) with a selection copies it (Windows Terminal style); without one Ctrl+C is ^C as always
      if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.code === 'KeyC' && term.hasSelection()) {
        doCopy();
        ev.preventDefault();
        return false;
      }
      // Ctrl+Shift+V / Shift+Insert → paste (Cmd+V on macOS)
      if ((ctrl && ev.shiftKey && !ev.altKey && ev.code === 'KeyV') || (ev.shiftKey && !ev.ctrlKey && !ev.altKey && insert)
          || (ev.metaKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyV')) {
        doPaste();
        ev.preventDefault();
        return false;
      }
      /* Printable keys (space, letters with or without Shift, digits,
         symbols, AltGr characters) are sent by us on keydown. xterm takes
         them from the textarea's input/composition events, and on Linux
         with IBus that path breaks: spaces vanish, or a stuck preedit eats
         Shift+letter and leaves xterm's composition box (a steady blue
         block) where the cursor was. Real compositions (dead keys,
         keyCode 229, CJK input) still take the default path. */
      const altGr = ev.getModifierState && ev.getModifierState('AltGraph');
      if (!IS_ANDROID && ev.key && [...ev.key].length === 1 && !ev.metaKey
          && (!ev.ctrlKey || altGr) && (!ev.altKey || altGr)
          && !wasDead && !ev.isComposing && ev.keyCode !== 229) {
        ev.preventDefault();
        term.input(ev.key, true);
        return false;
      }
      // Ctrl+Shift+N → new window (App handles it): xterm must not also send ^N
      if (!IS_ANDROID && ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.code === 'KeyN') {
        return false;
      }
      // Ctrl+F → Search
      if (ev.ctrlKey && !ev.shiftKey && ev.code === 'KeyF') {
        setShowSearch(true);
        return false;
      }
      return true;
    });

    /* Right-click: copies the selection if there is one, otherwise pastes
       (Settings → Right-click pastes). A program that took the mouse gets
       the click instead, unless Shift is held. On Android a long-press is a
       contextmenu too: there it selects instead, see mobile/touch.js. */
    const onContextMenu = (e) => {
      e.preventDefault();
      if (mouseIsApps(e)) return;
      if (doCopy()) return;
      if ((termSettingsRef.current || {}).rightClickPaste !== false) doPaste();
    };
    /* Middle-click pastes PRIMARY (the last selection, in any app), like
       every Linux terminal. Pasted on press; the release is swallowed so
       Chromium cannot paste it a second time into the textarea. */
    const onMiddleDown = (e) => {
      if (e.button !== 1 || mouseIsApps(e)) return;
      e.preventDefault();
      doPaste('selection');
    };
    const onMiddleUp = (e) => { if (e.button === 1 && !mouseIsApps(e)) e.preventDefault(); };
    /* Web: a browser has no PRIMARY to read, and pasting the clipboard on a
       stray wheel press could run commands: middle-click does nothing (it
       is swallowed, so a Linux browser cannot paste its own PRIMARY into
       the textarea either). A program that took the mouse still gets it. */
    const onMiddleWeb = (e) => { if (e.button === 1 && !mouseIsApps(e)) e.preventDefault(); };
    const wrapperEl = containerRef.current;
    if (!IS_ANDROID) {
      wrapperEl.addEventListener('contextmenu', onContextMenu);
      wrapperEl.addEventListener('mousedown', onSelectStart, true);
      document.addEventListener('mouseup', onSelectEnd);
      if (IS_WEB) {
        wrapperEl.addEventListener('mousedown', onMiddleWeb, true);
        wrapperEl.addEventListener('mouseup', onMiddleWeb, true);
        wrapperEl.addEventListener('auxclick', onMiddleWeb, true);
      } else if (PLATFORM === 'linux') {
        wrapperEl.addEventListener('mousedown', onMiddleDown, true);
        wrapperEl.addEventListener('mouseup', onMiddleUp, true);
        wrapperEl.addEventListener('auxclick', onMiddleUp, true);
      }
    }

    /* Android: pinch zoom, long-press selection, and the size other
       terminals were pinched to. */
    let detachTouch = null;
    const onPinchedFont = (e) => {
      const size = e.detail || termSettingsRef.current.fontSize || 14;
      if (term.options.fontSize !== size) term.options.fontSize = size;
      requestAnimationFrame(() => { try { fitAddon.fit(); } catch (err) { /* ignore */ } });
    };
    if (IS_ANDROID) {
      detachTouch = attachTouch(term, () => fitAddon.fit(), containerRef.current);
      /* For checks over CDP on the emulator (selection, modes); page-local */
      containerRef.current.__xterm = term;
      term.onSelectionChange(() => setHasSelection(term.hasSelection()));
      /* The keyboard or a rotation shrinks the rows: keep the prompt in view */
      term.onResize(() => term.scrollToBottom());
      window.addEventListener(FONT_EVENT, onPinchedFont);
    }
    /* Input from the keyboard, after the sticky modifiers */
    const filterInput = (data) => (inputFilterRef.current ? inputFilterRef.current(data) : data);

    /* Fit after a small delay (an adopted screen: after it is written) */
    restored.then(() => requestAnimationFrame(() => {
      if (disposed) return;
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
    }));


    /* Setup data flow based on mode (a mirrored pane: joinMirrored, below) */
    if (mirrorSid) {
      /* nothing here */
    } else if (hasApi()) {
      if (isLocal) {
        /* ─── Local Terminal Mode ─── */
        if (!adopt) term.writeln('\x1b[90mOpening local shell...\x1b[0m');

        /* Register data listeners FIRST with a pending queue */
        const pendingData = [];
        let sessionReady = false;

        window.electronAPI.localShell.onData((sid, data) => {
          if (!mountedRef.current) return;
          if (!sessionReady) {
            pendingData.push({ sid, data });
            return;
          }
          if (sid === sessionIdRef.current) {
            term.write(data);
            if (isLoggingRef.current) {
              logBufferRef.current.push(data);
            }
          }
        });

        window.electronAPI.localShell.onClose((sid, exitCode) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            setConnected(false);
            /* Reopened from Sessions → Background and it was gone (102): no dead tab */
            if (exitCode === 102 && tab.fromBackground) { goneFromBackground(); return; }
            term.writeln('\r\n\x1b[90m[Session ended]\x1b[0m');
          }
        });

        window.electronAPI.localShell.onError((sid, error) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
          }
        });

        /* Now spawn the shell, at the size the pane really has (fitted
           first; a hidden tab spawns when it is shown). Spawned at xterm's
           80x24 placeholder, the shell drew its first prompt (and a kept
           session its SIGWINCH redraw) for 80 columns in a wider terminal. */
        const fitNow = () => { try { fitAddon.fit(); } catch (e) { /* not laid out */ } };

        /* The pty is there (spawned now, or adopted from another window):
           wire input, resize and the first fit to it */
        const wireLocal = (realSessionId, fresh, info = {}) => {
            sessionIdRef.current = realSessionId;
            sessionReady = true;
            setConnected(fresh ? true : adopt.connected !== false);
            /* tab.sessionId is only a placeholder: closing, broadcast and
               snippets need the pty's id (not in this effect's deps).
               kept: a session the local keeper holds (closing asks, like SSH);
               sessionKey is pinned so a restore reattaches the same one. */
            if (fresh) dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, ptySessionId: realSessionId, kept: !!info.kept, sessionKey: tab.sessionKey || tab.id } });

            /* Flush any queued data */
            for (const item of pendingData) {
              if (item.sid === realSessionId) {
                term.write(item.data);
              }
            }
            pendingData.length = 0;

            /* Clear the "Opening..." message. A kept session's replay starts
               with ESC c and repaints the screen: never clear over it. */
            if (fresh && !info.kept) term.clear();
            if (fresh && info.notice) term.writeln(`\x1b[2m[${info.notice}]\x1b[0m`);

            /* Terminal -> local shell */
            term.onData((raw) => {
              const data = filterInput(raw);
              if (sessionIdRef.current) {
                window.electronAPI.localShell.write(sessionIdRef.current, data);
              }
              /* Broadcast: forward input to all other terminal sessions */
              if (broadcastRef.current && !noBroadcastRef.current) {
                const currentSid = sessionIdRef.current;
                tabsRef.current.forEach(otherTab => {
                  const sid = liveSessionId(otherTab);
                  if (!sid || sid === currentSid) return;
                  if (otherTab.type === 'local-terminal') {
                    window.electronAPI.localShell.write(sid, data);
                  } else if (otherTab.type === 'terminal' || otherTab.type === 'ssh') {
                    window.electronAPI.ssh.sendData(sid, data);
                  }
                });
              }
            });

            /* Resize */
            sendSize = (c, r) => {
              if (sessionIdRef.current) window.electronAPI.localShell.resize(sessionIdRef.current, c, r);
            };
            term.onResize(() => pushSize());

            /* Send initial fit resize */
            restored.then(() => {
              if (disposed) return;
              try { fitAddon.fit(); } catch (e) { /* ignore */ }
              pushSize(true);
            });
        };

        if (adopt) {
          if (tab.ptySessionId) wireLocal(tab.ptySessionId, false);
        } else (tab.spawnSize && !laidOut()
          /* Opened from the web mirror while this pane is hidden here: at the
             browser's size, not when (if ever) it is shown on the PC */
          ? Promise.resolve().then(() => (disposed ? null : window.electronAPI.localShell.spawn({ cols: tab.spawnSize.cols, rows: tab.spawnSize.rows, sessionKey: tab.sessionKey || tab.id })))
          : whenLaidOut().then(() => {
            if (disposed) return null;
            fitNow();
            return window.electronAPI.localShell.spawn({ cols: term.cols || 80, rows: term.rows || 24, sessionKey: tab.sessionKey || tab.id });
          }))
          .then((result) => {
            if (result === null) return;
            const realSessionId = result?.sessionId;
            /* Closed before the pty existed: nobody else knows its id, so
               nobody else would ever kill it */
            if (disposed || !mountedRef.current) {
              if (realSessionId) window.electronAPI.localShell.kill(realSessionId)?.catch?.(() => {});
              return;
            }
            if (!realSessionId) return;
            wireLocal(realSessionId, true, { kept: !!result.kept, notice: result.notice || null });
          })
          .catch((err) => {
            if (!mountedRef.current) return;
            term.writeln(`\x1b[31m✗ Failed to open local shell:\x1b[0m`);
            term.writeln(`\x1b[31m  ${err.message || err}\x1b[0m`);
          });

      } else {
        /* ─── SSH Terminal Mode ─── */
        if (!tab.sessionId) return;  /* Still connecting — don't init yet */
        sessionIdRef.current = tab.sessionId;

        /* Register listeners */
        window.electronAPI.ssh.onData((sid, data) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.write(data);
            if (isLoggingRef.current) {
              logBufferRef.current.push(data);
            }
          }
        });

        window.electronAPI.ssh.onClose((sid, info) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            setConnected(false);
            /* Auto-reconnect found the keeper session held elsewhere: the
               error view with Attach here instead of a dead terminal */
            if (info && info.reason === 'elsewhere') {
              dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, error: 'This session is open on another device', elsewhere: true } });
              return;
            }
            /* Reopened from Sessions → Background and the server no longer has it */
            if (info && info.reason === 'gone' && tab.fromBackground) { goneFromBackground(); return; }
            /* The Sessions screen shows it as disconnected */
            if (IS_ANDROID) dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, closed: true } });
            term.writeln('\r\n\x1b[90m[Connection closed]\x1b[0m');
          }
        });

        window.electronAPI.ssh.onError((sid, error) => {
          if (mountedRef.current && sid === sessionIdRef.current) {
            term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
          }
        });

        /* The link dropped and main is redialling (same session id; the
           "Reconnecting… (attempt n)" lines arrive as ordinary data). The
           dot goes grey meanwhile; once back, the new shell gets our size. */
        reconnectListener = window.electronAPI.ssh.onReconnect?.((p) => {
          if (!mountedRef.current || !p || p.sessionId !== sessionIdRef.current) return;
          if (p.state === 'reconnected') {
            setConnected(true);
            pushSize(true);
          } else if (p.state === 'lost' || p.state === 'reconnecting') {
            setConnected(false);
          }
        }) || null;

        /* Terminal -> SSH */
        term.onData((raw) => {
          const data = filterInput(raw);
          if (sessionIdRef.current) {
            window.electronAPI.ssh.sendData(sessionIdRef.current, data);
          }
          /* Broadcast: forward input to all other terminal sessions */
          if (broadcastRef.current && !noBroadcastRef.current) {
            const currentSid = sessionIdRef.current;
            tabsRef.current.forEach(otherTab => {
              const sid = liveSessionId(otherTab);
              if (!sid || sid === currentSid) return;
              if (otherTab.type === 'local-terminal') {
                window.electronAPI.localShell.write(sid, data);
              } else if (otherTab.type === 'terminal' || otherTab.type === 'ssh') {
                window.electronAPI.ssh.sendData(sid, data);
              }
            });
          }
        });

        /* Resize. A kept session's attach on the server waits for the first
           one (ssh-service _go): a hidden tab sends it when it is shown. */
        sendSize = (c, r) => {
          if (sessionIdRef.current) window.electronAPI.ssh.resize(sessionIdRef.current, c, r);
        };
        term.onResize(() => pushSize());

        setConnected(adopt ? adopt.connected !== false : true);

        /* Send initial resize to sync terminal dimensions */
        restored.then(() => setTimeout(() => {
          if (!mountedRef.current || disposed) return;
          try { fitAddon.fit(); } catch (e) { /* ignore */ }
          pushSize(true);
        }, 100));
      }
    } else {
      /* ─── Mock mode for browser dev ─── */
      setConnected(true);
      const username = isLocal ? 'user' : (tab.label || 'demo');
      const hostname = isLocal ? 'localhost' : 'server';
      term.writeln(`\x1b[32m✓ Connected to ${hostname}\x1b[0m`);
      term.writeln(`\x1b[90mWelcome to Termilab — ${isLocal ? 'Local' : 'SSH'} session\x1b[0m`);
      term.writeln('');
      term.write(`\x1b[36m${username}@${hostname}\x1b[0m:\x1b[34m~\x1b[0m$ `);

      term.onData((data) => {
        if (data === '\r') {
          term.writeln('');
          term.write(`\x1b[36m${username}@${hostname}\x1b[0m:\x1b[34m~\x1b[0m$ `);
        } else if (data === '\x7f') {
          term.write('\b \b');
        } else {
          term.write(data);
        }
      });
    }

    /* Web mirror: leave the PC's session (never ends it) */
    let mirrorCleanup = null;
    if (mirrorSid) mirrorCleanup = joinMirrored();
    function joinMirrored() {
      /* ─── Web mirror: one more viewer of the PC's session ───
         (electron/window-registry.js). join → 'session:join-screen' (the
         PC's screen at the request, then what came after, in order) → live.
         Input and resize go to the same session: main lets a viewer use it
         (mayUse) and the last client that typed conducts the pty's size; the
         others follow 'session:size'. */
      const sid = mirrorSid;
      sessionIdRef.current = sid;
      const svc = isLocal ? window.electronAPI.localShell : window.electronAPI.ssh;
      const sess = window.electronAPI.session;
      let joinId = null;
      let screenIn = false;
      const screens = new Map();   // join-screen pushes that beat the join's reply
      svc.onData((s, data) => {
        /* Before our screen: already in it (main buffers for a joining viewer) */
        if (disposed || s !== sid || !screenIn) return;
        term.write(data);
        if (isLoggingRef.current) logBufferRef.current.push(data);
      });
      svc.onClose((s) => {
        if (disposed || s !== sid) return;
        setConnected(false);
        term.writeln(`\r\n\x1b[90m[${isLocal ? 'Session ended' : 'Connection closed'}]\x1b[0m`);
      });
      svc.onError((s, error) => {
        if (!disposed && s === sid) term.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
      });
      const reconnect = !isLocal ? window.electronAPI.ssh.onReconnect?.((p) => {
        if (disposed || !p || p.sessionId !== sid) return;
        if (p.state === 'reconnected') setConnected(true);
        else if (p.state === 'lost' || p.state === 'reconnecting') setConnected(false);
      }) : null;
      const applyScreen = (p) => {
        screenIn = true;
        /* The pty's size, as the PC has it: followed until the user types here */
        if (p.sized && Number.isInteger(p.cols) && Number.isInteger(p.rows) && p.cols > 0 && p.rows > 0) {
          follow = { cols: p.cols, rows: p.rows };
          try { term.resize(p.cols, p.rows); } catch (_) { /* disposed */ }
        }
        if (p.data) term.write(p.data);
        if (!p.history) term.writeln('\x1b[2m[Joined live: earlier output is not available here]\x1b[0m');
        setConnected(p.connected !== false);
        term.onData((raw) => {
          const data = filterInput(raw);
          if (isLocal) window.electronAPI.localShell.write(sid, data);
          else window.electronAPI.ssh.sendData(sid, data);
        });
        sendSize = (c, r) => {
          if (isLocal) window.electronAPI.localShell.resize(sid, c, r);
          else window.electronAPI.ssh.resize(sid, c, r);
        };
        term.onResize(() => pushSize());
        /* Not sized yet (the PC's pane hidden, waitSize): this size opens it */
        if (!follow) {
          try { fitAddon.fit(); } catch (_) { /* not laid out */ }
          pushSize(true);
        }
      };
      const joinListener = sess.onJoinScreen((p) => {
        if (disposed || !p || p.sessionId !== sid || screenIn) return;
        if (joinId && p.joinId === joinId) applyScreen(p);
        else screens.set(p.joinId, p);
      });
      sess.join(sid).then((r) => {
        if (disposed) return;
        joinId = r && r.joinId;
        const p = screens.get(joinId);
        screens.clear();
        if (p && !screenIn) applyScreen(p);
      }).catch((err) => {
        if (!disposed) term.writeln(`\x1b[31m✗ Could not show this session: ${err.message || err}\x1b[0m`);
      });
      return () => {
        sess.offEvents(joinListener);
        if (reconnect) window.electronAPI.ssh.removeReconnectListener?.(reconnect);
        sess.leave(sid).catch(() => {});
      };
    }

    /* ResizeObserver for auto-fit (an adopted screen: once it is written) */
    const ro = new ResizeObserver(() => {
      if (follow) return;   // another client conducts the size (see sizeListener)
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
      /* Shown at last (a tab restored hidden), or at a size equal to the
         placeholder: nothing resized, but the pty has not heard it yet */
      pushSize();
    });
    const observed = containerRef.current;
    restored.then(() => { if (!disposed) ro.observe(observed); });

    /* Adopted: the screen is in, the listeners are up. Main may now route the
       session here and flush what it buffered during the move. */
    if (adopt) {
      restored.then(() => {
        if (disposed) return;
        adoptedReady(adopt.moveId, isLocal ? tab.ptySessionId : tab.sessionId);
        dispatch({ type: 'UPDATE_TAB', payload: { id: tab.id, adopt: null } });
      });
    }

    /* The web font (JetBrains Mono, from Google Fonts with display=swap) often
       arrives after xterm has measured its cells with the fallback font. xterm
       keeps the old cell width while drawing the wider/narrower glyphs, so text
       overlaps and programs that redraw a growing input box (Claude CLI, zsh
       right prompts) end up on top of themselves. When fonts finish loading,
       make xterm measure again and refit, which also resends the pty size. */
    const remeasure = () => {
      if (!mountedRef.current) return;
      const fam = term.options.fontFamily;
      term.options.fontFamily = 'monospace';
      term.options.fontFamily = fam;
      try { fitAddon.fit(); } catch (e) { /* not laid out */ }
      term.refresh(0, term.rows - 1);
    };
    const fonts = document.fonts;
    if (fonts) {
      const fam = (term.options.fontFamily || '').split(',')[0].trim().replace(/['"]/g, '');
      const size = term.options.fontSize || 14;
      if (fam && !fonts.check(`${size}px "${fam}"`)) {
        fonts.load(`${size}px "${fam}"`).then(remeasure, () => {});
      }
      fonts.addEventListener?.('loadingdone', remeasure);
    }

    /* Keyboard shortcut: Ctrl+Shift+F for search */
    const keyHandler = (e) => {
      /* Every terminal of the app is mounted (split panes, hidden tabs):
         only the one with the keyboard opens its search */
      const own = containerRef.current?.closest('.terminal-container');
      if (!IS_ANDROID && (!own || !own.contains(document.activeElement))) return;
      if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    document.addEventListener('keydown', keyHandler);

    return () => {
      disposed = true;
      detachPaths();
      if (mirrorCleanup) mirrorCleanup();
      if (reconnectListener) window.electronAPI?.ssh?.removeReconnectListener?.(reconnectListener);
      if (sizeListener) window.electronAPI?.session?.offEvents?.(sizeListener);
      if (conductorListener) window.electronAPI?.session?.offEvents?.(conductorListener);
      followKey.dispose();
      clearTimeout(scanTimer);
      for (const id of [...talkWatches.keys()]) talkDrop(id);
      if (talkRef.current === talk) talkRef.current = null;
      if (term.textarea) term.textarea.removeEventListener('keydown', onKey);
      unregister();
      mountedRef.current = false;
      initializedRef.current = false;  // Allow re-init on StrictMode remount
      ro.disconnect();
      if (layoutWait) layoutWait.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', remeasure);
      document.removeEventListener('keydown', keyHandler);
      wrapperEl.removeEventListener('contextmenu', onContextMenu);
      wrapperEl.removeEventListener('mousedown', onSelectStart, true);
      document.removeEventListener('mouseup', onSelectEnd);
      wrapperEl.removeEventListener('mousedown', onMiddleDown, true);
      wrapperEl.removeEventListener('mouseup', onMiddleUp, true);
      wrapperEl.removeEventListener('auxclick', onMiddleUp, true);
      wrapperEl.removeEventListener('mousedown', onMiddleWeb, true);
      wrapperEl.removeEventListener('mouseup', onMiddleWeb, true);
      wrapperEl.removeEventListener('auxclick', onMiddleWeb, true);
      if (term.textarea) {
        term.textarea.removeEventListener('focus', seen);
        term.textarea.removeEventListener('keydown', seen);
      }
      if (detachTouch) detachTouch();
      window.removeEventListener(FONT_EVENT, onPinchedFont);
      term.dispose();
    };

  }, [tab.sessionId, tab.connecting, mirrorKey]); // Re-run when sessionId arrives

  /* "Paste N lines?": pasteInto waits on this promise (Enter pastes, Esc cancels) */
  const pasteAskRef = useRef(null);
  const neverAskRef = useRef(null);
  askPasteRef.current = (info) => new Promise((resolve) => {
    if (pasteAskRef.current) pasteAskRef.current.resolve(false);
    const ask = { lines: info.lines, chars: info.chars, resolve };
    pasteAskRef.current = ask;
    setPasteAsk(ask);
  });
  const answerPaste = (ok) => {
    const ask = pasteAskRef.current;
    if (!ask) return;
    pasteAskRef.current = null;
    setPasteAsk(null);
    if (ok && neverAskRef.current?.checked) {
      const settings = stateRef.current.settings || {};
      actions.saveSettings({ ...settings, terminal: { ...(settings.terminal || {}), warnMultilinePaste: false } }).catch(() => {});
    }
    termRef.current?.focus();
    ask.resolve(ok);
  };
  useEffect(() => () => { if (pasteAskRef.current) pasteAskRef.current.resolve(false); }, []);

  /* "Click to copy" waits a few seconds, then the copy is dropped */
  useEffect(() => {
    if (!clickToCopy) return undefined;
    const t = setTimeout(() => setClickToCopy(null), 8000);
    return () => clearTimeout(t);
  }, [clickToCopy]);

  /* The "Copied" hint goes away by itself */
  useEffect(() => {
    if (!copiedAt) return undefined;
    const t = setTimeout(() => setCopiedAt(0), 1100);
    return () => clearTimeout(t);
  }, [copiedAt]);

  /* Keep activeTabIdRef in sync for the onBell closure */
  useEffect(() => {
    activeTabIdRef.current = state.activeTabId;
  }, [state.activeTabId]);

  /* Apply terminal settings reactively (font size, cursor, etc.) */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    /* Android: a pinched size wins until Settings changes the size */
    const settingsFont = termSettings.fontSize || 14;
    if (IS_ANDROID && lastSettingsFontRef.current !== undefined && lastSettingsFontRef.current !== settingsFont) {
      writePinchedFont(null);
    }
    lastSettingsFontRef.current = settingsFont;
    const newFontSize = (IS_ANDROID && readPinchedFont()) || settingsFont;
    const newFontFamily = terminalFontFamily(termSettings.fontFamily);
    const newCursorStyle = termSettings.cursorStyle || 'block';

    if (term.options.fontSize !== newFontSize) term.options.fontSize = newFontSize;
    if (term.options.fontFamily !== newFontFamily) term.options.fontFamily = newFontFamily;
    if (term.options.cursorStyle !== newCursorStyle) term.options.cursorStyle = newCursorStyle;

    /* Re-fit after font change */
    requestAnimationFrame(() => {
      try { fitAddonRef.current?.fit(); } catch (e) { /* ignore */ }
    });
  }, [termSettings.fontSize, termSettings.fontFamily, termSettings.cursorStyle]);


  /* Scheme changed in Settings, or this terminal's colour (its own, or its
     host's) changed: repaint in place */
  useEffect(() => {
    const term = termRef.current;
    if (term && term.options.theme !== theme) term.options.theme = theme;
  }, [theme]);

  /* Search handlers */
  const handleSearch = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  }, [searchQuery]);

  const closeSearch = () => {
    setShowSearch(false);
    setSearchQuery('');
    if (searchAddonRef.current) {
      searchAddonRef.current.clearDecorations();
    }
    termRef.current?.focus();
  };

  /* The chrome around xterm should match the terminal theme's own background,
     not the app theme — otherwise a light terminal sits in a dark frame. */
  const containerStyle = {
    '--terminal-bg': theme.background,
  };

  /* ─── Android: header, extra keys, selection ─── */
  const inject = (term, fn) => {
    bypassRef.current = true;
    try { fn(); } finally { bypassRef.current = false; }
  };
  const sendKey = (id) => {
    const term = termRef.current;
    if (!term) return;
    const mods = modifiers.peek();
    const seq = keySequence(id, { appCursor: !!term.modes?.applicationCursorKeysMode, ...mods });
    if (mods.ctrl || mods.alt) modifiers.spend();
    /* term.input fires onData synchronously: same path as typing, so
       broadcast and everything else downstream see it */
    inject(term, () => term.input(seq, true));
  };
  /* Android buttons: the same paste / copy as the desktop keys */
  const pasteClipboard = () => {
    const term = termRef.current;
    if (!term) return;
    pasteInto(term, {
      onImage: pasteImageRef.current || undefined,
      confirm: termSettings.warnMultilinePaste === false ? undefined : (info) => askPasteRef.current(info),
      paste: (text) => inject(term, () => term.paste(text)),
    }).catch(() => {});
  };
  const copyAndClear = () => {
    const term = termRef.current;
    if (!term) return;
    copySelection(term).then((r) => { if (r.copied) setCopiedAt(Date.now()); });
    term.clearSelection();
  };
  /* Composer → this session only: one paste (bracketed when the program
     asked for it), then Enter a moment later as its own key. Never broadcast;
     on Android, past the sticky Ctrl/Alt. */
  const sendComposed = (text, enter) => {
    const term = termRef.current;
    if (!term || (hasApi() && !sessionIdRef.current)) return false;
    const here = (fn) => {
      noBroadcastRef.current = true;
      bypassRef.current = true;
      try { fn(); } finally { noBroadcastRef.current = false; bypassRef.current = false; }
    };
    here(() => term.paste(text));
    if (enter) setTimeout(() => { if (termRef.current === term) here(() => term.input('\r', true)); }, 120);
    return true;
  };
  const closeComposer = () => {
    setComposeOpen(false);
    termRef.current?.focus();
  };
  const composer = composeOpen ? (
    <Composer
      tab={tab}
      color={tabColor(tab, state.hosts)}
      focusSignal={composeFocus}
      mobile={IS_ANDROID}
      onSend={sendComposed}
      onAttach={(!IS_ANDROID && canAttach())
        ? (items, { paste, onStatus }) => attachImages(termRef.current, tabLiveRef.current, items, { onStatus, paste })
        : null}
      onClose={closeComposer}
      onFocusTerminal={() => termRef.current?.focus()}
      suggestion={suggestion}
      choices={choices}
      onAnswer={(c) => answerPrompt(c, { keepFocus: true })}
      onAnswerText={answerWithText}
    />
  ) : null;
  const toggleComposer = () => (composeOpen ? closeComposer() : composeKeyRef.current());

  const mobileHeader = IS_ANDROID ? (
    <SessionHeader
      tab={tab}
      status={sessionStatus(tab)}
      onResetZoom={() => writePinchedFont(null)}
    />
  ) : null;

  /* Show loading overlay for SSH connecting state */
  if (!isLocal && (tab.connecting || (!tab.sessionId && !tab.error))) {
    return (
      <div className="terminal-container" style={containerStyle}>
        {mobileHeader}
        <div className="terminal-connecting">
          <div className="terminal-connecting-spinner" />
          <div className="terminal-connecting-text">Connecting to {tab.label || 'host'}...</div>
          <div className="terminal-connecting-host">
            {tab.hostConfig?.username}@{tab.hostConfig?.hostname}:{tab.hostConfig?.port || 22}
          </div>
        </div>
        <div className="terminal-status">
          <span className="terminal-status-dot disconnected" />
          <span>{tab.alias ? paneTitle(tab) : (tab.label || 'SSH')} — Connecting...</span>
        </div>
      </div>
    );
  }

  /* Show error state */
  if (tab.error) {
    return (
      <div className="terminal-container" style={containerStyle}>
        {mobileHeader}
        <div className="terminal-connecting">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <div style={{color: 'var(--color-danger)', fontWeight: 500}}>{tab.elsewhere ? 'Open on another device' : tab.skipped ? 'Not reconnected' : 'Connection Failed'}</div>
          <div className="terminal-connecting-host">{tab.error}</div>
          {tab.elsewhere && (
            <button type="button" className="keeper-btn keeper-btn-primary" onClick={() => actions.takeOverSession(tab.id)}
              title="Attaching here detaches it from the other device">
              Attach here
            </button>
          )}
        </div>
        <div className="terminal-status">
          <span className="terminal-status-dot disconnected" />
          <span>{tab.alias ? paneTitle(tab) : (tab.label || 'SSH')} — {tab.skipped ? 'Not reconnected' : 'Failed'}</span>
        </div>
      </div>
    );
  }

  /* Image files dragged in from the OS (never our own pane/tab drags: those
     carry DRAG_MIME and the stage's drop layer takes them) */
  const fileDrop = (!IS_ANDROID && canAttach()) ? {
    onDragEnter: (e) => { if (isFilesDrag(e)) { e.preventDefault(); setFileOver(true); } },
    onDragOver: (e) => {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!fileOver) setFileOver(true);
    },
    onDragLeave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      setFileOver(false);
    },
    onDrop: (e) => {
      if (!isFilesDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setFileOver(false);
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) attachRef.current(files);
      termRef.current?.focus();
    },
  } : {};

  return (
    <div className={`terminal-container${fileOver ? ' file-drop-over' : ''}`} style={containerStyle} {...fileDrop}>
      {mobileHeader}
      {attachStatus && (
        <div className={`terminal-attach-status${attachStatus.kind === 'error' ? ' error' : ''}`} role="status">
          {attachStatus.text}
        </div>
      )}
      {showSearch && (
        <div className="terminal-search">
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (e.shiftKey) handleSearchPrev();
                else handleSearch();
              }
              if (e.key === 'Escape') closeSearch();
            }}
            autoFocus
          />
          <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button className="terminal-search-btn" onClick={handleSearch} title="Next">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button className="terminal-search-btn" onClick={closeSearch} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        </div>
      )}

      <div className="terminal-wrapper" ref={containerRef} />
      {/* With the composer open its chips answer instead (no duplicates) */}
      <PromptActions choices={composeOpen ? null : choices} onAnswer={answerPrompt} />
      {composer}

      {copiedAt > 0 && <div className="terminal-copied-hint" key={copiedAt} role="status">Copied</div>}
      {clickToCopy && !copiedAt && (
        <button
          type="button"
          className="terminal-copied-hint terminal-click-copy"
          key={clickToCopy.at}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const { text } = clickToCopy;
            setClickToCopy(null);
            writeClipboardText(text).then((ok) => { if (ok) setCopiedAt(Date.now()); }).catch(() => {});
            termRef.current?.focus();
          }}
        >Click to copy</button>
      )}
      {pasteAsk && (
        <div
          className="terminal-paste-confirm"
          role="alertdialog"
          aria-label="Confirm paste"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); answerPaste(false); } }}
        >
          <div className="terminal-paste-confirm-text">
            <strong>Paste {pasteAsk.lines} {pasteAsk.lines === 1 ? 'line' : 'lines'}?</strong>
            <span>This program has no bracketed paste: each line runs as it arrives.</span>
          </div>
          <label className="terminal-paste-confirm-never">
            <input type="checkbox" ref={neverAskRef} /> Don't ask again
          </label>
          <button type="button" className="terminal-paste-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => answerPaste(false)}>Cancel</button>
          <button type="button" className="terminal-paste-btn primary" autoFocus onClick={() => answerPaste(true)}>Paste</button>
        </div>
      )}

      {IS_ANDROID && hasSelection && (
        <div className="m-selection-bar">
          <button type="button" className="m-chip m-chip-primary" onMouseDown={(e) => e.preventDefault()} onClick={copyAndClear}>Copy</button>
          <button type="button" className="m-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => termRef.current?.clearSelection()}>Cancel</button>
        </div>
      )}
      {IS_ANDROID && <ExtraKeys modifiers={modifiers} onKey={sendKey} onPaste={pasteClipboard} onCompose={toggleComposer} />}

      {/* ─── Bottom Bar: Status (desktop; on Android the header says it) ─── */}
      {!IS_ANDROID && <div className="terminal-bottom-bar">
        <div className="terminal-status">
          <span className={`terminal-status-dot ${connected ? '' : 'disconnected'}`} />
          <span>
            {tab.alias ? paneTitle(tab) : (isLocal ? 'Local Shell' : (tab.label || 'SSH'))}
            {connected ? '' : ' — Disconnected'}
          </span>
        </div>

        {/* ─── Session Log Controls ─── */}
        <div className="session-log-controls">
          <ComposeButton open={composeOpen} onClick={toggleComposer} />
          <button
            className={`session-log-toggle ${isLogging ? 'active' : ''}`}
            onClick={() => {
              const next = !isLogging;
              setIsLogging(next);
              isLoggingRef.current = next;
              if (next) logBufferRef.current = [];
            }}
            title={isLogging ? 'Stop logging' : 'Start session logging'}
          >
            {isLogging && <span className="session-log-rec-dot" />}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
            <span>Log</span>
          </button>
          {isLogging && (
            <button
              className="session-log-save"
              onClick={() => {
                const text = logBufferRef.current.join('');
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                a.href = url;
                a.download = `session-${ts}.log`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              title="Save session log"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Save
            </button>
          )}
        </div>
      </div>}
    </div>
  );
}
