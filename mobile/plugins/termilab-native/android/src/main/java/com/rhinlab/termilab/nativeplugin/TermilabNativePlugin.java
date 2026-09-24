package com.rhinlab.termilab.nativeplugin;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS side: `registerPlugin('TermilabNative')` in mobile/web/entry.jsx.
 *
 *   setSessionCount({count, signingIn})
 *                               foreground service on/off/update (+ asks for
 *                               POST_NOTIFICATIONS once, Android 13+, on the
 *                               first SSH session - not for a login)
 *   setTerminalInput({on})      keyboard mode, see TerminalInputWebView
 *   exitApp()                   back from Hosts home: moveTaskToBack, never finish()
 *   readClipboard() -> {text}   the terminal's paste key, when the WebView's
 *   writeClipboard({text})      async clipboard refuses (no permission prompt
 *                               in a WebView)
 *   setWindowBackground({color}) '#rrggbb' behind the system bars: on WebViews
 *                               older than Chromium 140 Capacitor pads the
 *                               WebView and this is what shows there
 *   event 'backButton'          every system back; the page decides what it does
 *
 * The device key is not here: it has to exist before Node starts, which is
 * before any page can call a plugin (MainActivity hands DeviceKey to the Node
 * plugin's env provider).
 */
@CapacitorPlugin(
    name = "TermilabNative",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class TermilabNativePlugin extends Plugin {

    private static final String PREFS = "termilab_native";
    private static final String PREF_ASKED_NOTIFICATIONS = "asked_notifications";

    @Override
    public void load() {
        final Activity activity = getActivity();
        if (activity instanceof AppCompatActivity) {
            ((AppCompatActivity) activity).getOnBackPressedDispatcher().addCallback(
                (AppCompatActivity) activity,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        // No page listening (still loading, or it failed): behave
                        // like Hosts home rather than swallow the key.
                        if (hasListeners("backButton")) notifyListeners("backButton", new JSObject(), true);
                        else activity.moveTaskToBack(true);
                    }
                }
            );
        }
    }

    @PluginMethod
    public void setSessionCount(PluginCall call) {
        final int count = Math.max(0, call.getInt("count", 0));
        final boolean signingIn = Boolean.TRUE.equals(call.getBoolean("signingIn", false));
        SessionService.apply(getContext(), count, signingIn);
        if (count > 0 && needsNotificationPrompt()) {
            getContext().getSharedPreferences(PREFS, 0).edit().putBoolean(PREF_ASKED_NOTIFICATIONS, true).apply();
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        resolveCount(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        if (getPermissionState("notifications") == PermissionState.GRANTED) SessionService.repost();
        resolveCount(call);
    }

    private void resolveCount(PluginCall call) {
        final JSObject ret = new JSObject();
        ret.put("running", SessionService.isRunning());
        ret.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /** Asked once: after a "no" the service still runs, its notification just stays out of the shade. */
    private boolean needsNotificationPrompt() {
        if (Build.VERSION.SDK_INT < 33) return false;
        if (getPermissionState("notifications") == PermissionState.GRANTED) return false;
        return !getContext().getSharedPreferences(PREFS, 0).getBoolean(PREF_ASKED_NOTIFICATIONS, false);
    }

    @PluginMethod
    public void setTerminalInput(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        final WebView wv = getBridge().getWebView();
        if (wv instanceof TerminalInputWebView) {
            ((TerminalInputWebView) wv).setTerminalInput(on);
            call.resolve();
        } else {
            call.reject("WebView is not TerminalInputWebView (layout override missing?)");
        }
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            final ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            final JSObject ret = new JSObject();
            String text = "";
            if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
                final CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(getContext());
                if (cs != null) text = cs.toString();
            }
            ret.put("text", text);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void writeClipboard(PluginCall call) {
        final String text = call.getString("text", "");
        getActivity().runOnUiThread(() -> {
            final ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) { call.reject("no clipboard"); return; }
            cm.setPrimaryClip(ClipData.newPlainText("Termilab", text));
            call.resolve();
        });
    }

    @PluginMethod
    public void setWindowBackground(PluginCall call) {
        final String color = call.getString("color", "");
        final int parsed;
        try { parsed = Color.parseColor(color); } catch (IllegalArgumentException e) { call.reject("bad color"); return; }
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().getDecorView().setBackgroundColor(parsed);
            call.resolve();
        });
    }
}
