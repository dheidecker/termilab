package com.rhinlab.termilab.nativeplugin;

import android.content.Context;
import android.util.AttributeSet;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView with the keyboard mode scoped to the terminal.
 *
 * Gboard's predictive/composing input garbles xterm.js ("echo hola" arrives as
 * "echo holalaa", spike finding #1). Capacitor's `captureInput` fixes it by
 * giving the IME a plain BaseInputConnection (the IME then sends key events,
 * which xterm reads byte for byte) - but for the whole WebView, so forms lose
 * accents, autocorrect and dictation.
 *
 * Here the page says when the xterm textarea has focus (TermilabNative
 * .setTerminalInput, from mobile/web/entry.jsx on focusin/focusout) and only
 * then does the IME get the captureInput connection; everything else gets
 * Chromium's normal one. restartInput() makes the IME ask again right away.
 *
 * Installed by overriding Capacitor's capacitor_bridge_layout_main.xml in the
 * app module. `android.captureInput` must stay OFF in capacitor.config.json, or
 * CapacitorWebView captures everywhere again.
 */
public class TerminalInputWebView extends CapacitorWebView {

    private volatile boolean terminalInput = false;
    private BaseInputConnection terminalConnection;

    public TerminalInputWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    /** Any thread. */
    public void setTerminalInput(boolean on) {
        post(() -> {
            if (terminalInput == on) return;
            terminalInput = on;
            final InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.restartInput(this);
        });
    }

    public boolean isTerminalInput() {
        return terminalInput;
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        if (!terminalInput) return super.onCreateInputConnection(outAttrs);
        // What captureInput does (inputType stays TYPE_NULL: the IME sends raw
        // key events, no composing, no suggestions), plus no fullscreen extract
        // UI in landscape.
        outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN;
        if (terminalConnection == null) terminalConnection = new BaseInputConnection(this, false);
        return terminalConnection;
    }
}
