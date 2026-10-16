import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import { useApp } from '../../contexts/AppContext';
import { getTheme } from '../../themes/terminal-themes';
import { tintTheme } from '../../themes/tint';
import { tabColor } from '../HostList/hostColor';
import { paneTitle, groupOf, focusedPaneOf } from '../SplitPane/layoutTree';
import { IS_ANDROID, PLATFORM, FEATURES } from '../../platform';
import ExtraKeys, { useStickyModifiers } from './mobile/ExtraKeys';
import SessionHeader from './mobile/SessionHeader';
import { applyModifiers, keySequence } from './mobile/keys';
import { attachTouch, readPinchedFont, writePinchedFont, FONT_EVENT } from './mobile/touch';
import { pasteInto, copySelection, writeText as writeClipboardText } from './clipboardPaste';
import { sessionStatus } from '../Mobile/sessions';
import { liveSessionId } from '../SplitPane/sessions';
import { registerTerminal, adoptedReady } from '../SplitPane/windowMove';
import { playChime, playQuestionChime, TYPING_QUIET_MS } from './agentChime';
import { detectAgent, screenTail, createAgentTracker, NEEDS_YOU_TEXT, parseChoices, cursorRowText, claudeSuggestion, screenCells } from './agentRules';
import PromptActions from '../Agents/PromptActions';
import './TerminalView.css';
import '../Keeper/Keeper.css';
import { showToast } from '../Keeper/toast';
import { attachImages, canAttach, isFilesDrag } from './imageAttach';
import Composer, { ComposeButton } from './Composer';
import { attachPathLinks } from './pathLinkProvider';

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
      fontFamily: termSettings.fontFamily || 'JetBrains Mono, Consolas, monospace',
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
    });

    /* ─── Attention: bell mark, agent chime, desktop notification ───
       Agent CLIs (Claude Code, Codex...) end a turn with BEL or a
       notification escape (OSC 9 / 777 notify / 99). Either plays the chime
       unless muted (Settings → Terminal, or this terminal's own mute); a
       plain BEL right after typing is the shell complaining and only marks
       the tab, as before. When the window is not focused a desktop
       notification says which terminal it was. */
    let lastTyped = 0;
    /* Focusing or typing in a pane is looking at it: its "done" mark goes.
       From the textarea's own focus/keydown, NOT onData: xterm also emits
       onData by itself (focus reports \e[I/\e[O, cursor-position and DA
       replies a TUI asks for while redrawing), which would clear the mark
       of a pane nobody looked at. */
    const seen = () => {
      const live = tabLiveRef.current || tab;
      if (live.doneAt) dispatch({ type: 'PANE_SEEN', payload: live.id });
    };
    term.onData(() => { lastTyped = Date.now(); });
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
      const r = tracker.scan(detectAgent(screenTail(term), prev && prev.id), Date.now(),
        { typedRecently: Date.now() - lastKey < TYPING_QUIET_MS });
      if (r.changed) publish(r.agent);
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
      const clipboard = /[cs0-7]/.test(targets) || !/p/.test(targets);
      const selection = /p/.test(targets);
      writeClipboardText(text, { clipboard, selection }).then((ok) => { if (ok && !disposed) setCopiedAt(Date.now()); }).catch(() => {});
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
    const onSelectStart = (e) => { if (e.button === 0) selecting = true; };
    const onSelectEnd = (e) => {
      if (e.button !== 0 || !selecting) return;
      selecting = false;
      setTimeout(() => {
        if (disposed || !term.hasSelection()) return;
        const onSelect = (termSettingsRef.current || {}).copyOnSelect !== false;
        if (!onSelect && PLATFORM !== 'linux') return;
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
      if (ev.key === 'Dead') { afterDeadKey = true; return true; }
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
    const wrapperEl = containerRef.current;
    if (!IS_ANDROID) {
      wrapperEl.addEventListener('contextmenu', onContextMenu);
      wrapperEl.addEventListener('mousedown', onSelectStart, true);
      document.addEventListener('mouseup', onSelectEnd);
      if (PLATFORM === 'linux') {
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


    /* Setup data flow based on mode */
    if (hasApi()) {
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

        /* Now spawn the shell */
        const cols = term.cols || 80;
        const rows = term.rows || 24;

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
            term.onResize(({ cols: c, rows: r }) => {
              if (sessionIdRef.current) {
                window.electronAPI.localShell.resize(sessionIdRef.current, c, r);
              }
            });

            /* Send initial fit resize */
            restored.then(() => {
              if (disposed) return;
              try {
                fitAddon.fit();
                window.electronAPI.localShell.resize(realSessionId, term.cols, term.rows);
              } catch (e) { /* ignore */ }
            });
        };

        if (adopt) {
          if (tab.ptySessionId) wireLocal(tab.ptySessionId, false);
        } else window.electronAPI.localShell.spawn({ cols, rows, sessionKey: tab.sessionKey || tab.id })
          .then((result) => {
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
            try { window.electronAPI.ssh.resize(sessionIdRef.current, term.cols, term.rows); } catch (_) { /* gone */ }
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

        /* Resize */
        term.onResize(({ cols: c, rows: r }) => {
          if (sessionIdRef.current) {
            window.electronAPI.ssh.resize(sessionIdRef.current, c, r);
          }
        });

        setConnected(adopt ? adopt.connected !== false : true);

        /* Send initial resize to sync terminal dimensions */
        restored.then(() => setTimeout(() => {
          if (!mountedRef.current || disposed) return;
          try {
            fitAddon.fit();
            window.electronAPI.ssh.resize(sessionIdRef.current, term.cols, term.rows);
          } catch (e) { /* ignore */ }
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

    /* ResizeObserver for auto-fit (an adopted screen: once it is written) */
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
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
      if (reconnectListener) window.electronAPI?.ssh?.removeReconnectListener?.(reconnectListener);
      clearTimeout(scanTimer);
      if (term.textarea) term.textarea.removeEventListener('keydown', onKey);
      unregister();
      mountedRef.current = false;
      initializedRef.current = false;  // Allow re-init on StrictMode remount
      ro.disconnect();
      document.fonts?.removeEventListener?.('loadingdone', remeasure);
      document.removeEventListener('keydown', keyHandler);
      wrapperEl.removeEventListener('contextmenu', onContextMenu);
      wrapperEl.removeEventListener('mousedown', onSelectStart, true);
      document.removeEventListener('mouseup', onSelectEnd);
      wrapperEl.removeEventListener('mousedown', onMiddleDown, true);
      wrapperEl.removeEventListener('mouseup', onMiddleUp, true);
      wrapperEl.removeEventListener('auxclick', onMiddleUp, true);
      if (term.textarea) {
        term.textarea.removeEventListener('focus', seen);
        term.textarea.removeEventListener('keydown', seen);
      }
      if (detachTouch) detachTouch();
      window.removeEventListener(FONT_EVENT, onPinchedFont);
      term.dispose();
    };

  }, [tab.sessionId, tab.connecting]); // Re-run when sessionId arrives

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
    const newFontFamily = termSettings.fontFamily || 'JetBrains Mono, Consolas, monospace';
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
