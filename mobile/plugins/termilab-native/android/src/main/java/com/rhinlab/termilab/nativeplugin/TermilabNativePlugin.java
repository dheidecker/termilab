package com.rhinlab.termilab.nativeplugin;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

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
 *   installApk({path, versionCode}) -> {launched}
 *                               the updater's last step (Node downloaded and
 *                               verified the APK's sha256): refuses a file outside
 *                               Node's updates/ dir, another package, a versionCode
 *                               not above the installed one or another signing key;
 *                               asks for "install unknown apps" when missing and
 *                               continues once the user is back; then opens the
 *                               system installer through the FileProvider
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

    private static final String TAG = "TermilabUpdate";
    private static final String PREFS = "termilab_native";
    /** Node's DATADIR is filesDir/nodejs/data (the Node plugin); the updater writes to updates/ under it. */
    private static final String UPDATES_DIR = "nodejs/data/updates";
    private static final String APK_MIME = "application/vnd.android.package-archive";
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

    // ─── Updater ──────────────────────────────────────────────

    @PluginMethod
    public void installApk(PluginCall call) {
        final File apk;
        try {
            apk = checkedApk(call.getString("path", ""), call.getLong("versionCode", 0L));
        } catch (IllegalArgumentException | IOException e) {
            Log.w(TAG, "refused: " + e.getMessage());
            call.reject(e.getMessage());
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Android kills nothing when this is granted; we come back to unknownSourcesAnswered.
            final Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, settings, "unknownSourcesAnswered");
            return;
        }
        launchInstaller(call, apk);
    }

    @ActivityCallback
    private void unknownSourcesAnswered(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("Allow Termilab to install unknown apps to update it (Settings, Install unknown apps)");
            return;
        }
        final File apk;
        try {
            apk = checkedApk(call.getString("path", ""), call.getLong("versionCode", 0L));
        } catch (IllegalArgumentException | IOException e) {
            call.reject(e.getMessage());
            return;
        }
        launchInstaller(call, apk);
    }

    private void launchInstaller(PluginCall call, File apk) {
        final Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        final Intent install = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(install);
        } catch (ActivityNotFoundException e) {
            call.reject("No package installer on this device");
            return;
        }
        Log.i(TAG, "installer opened for " + apk.getName());
        final JSObject ret = new JSObject();
        ret.put("launched", true);
        call.resolve(ret);
    }

    /**
     * The archive Node hands over, checked before the system installer sees it.
     * Android refuses another key on its own; checking here gives the user a
     * reason instead of the installer's generic "App not installed".
     */
    private File checkedApk(String path, long expectedVersionCode) throws IOException {
        final File dir = new File(getContext().getFilesDir(), UPDATES_DIR).getCanonicalFile();
        final File apk = new File(path).getCanonicalFile();
        if (!apk.getName().endsWith(".apk") || !dir.equals(apk.getParentFile())) throw new IllegalArgumentException("Update file is not in the updates folder");
        if (!apk.isFile()) throw new IllegalArgumentException("Downloaded update is missing");

        final PackageManager pm = getContext().getPackageManager();
        final int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        final PackageInfo archive = pm.getPackageArchiveInfo(apk.getPath(), flags);
        if (archive == null) throw new IllegalArgumentException("Downloaded update is not a valid APK");
        if (!getContext().getPackageName().equals(archive.packageName)) throw new IllegalArgumentException("Downloaded update is for another app (" + archive.packageName + ")");

        final PackageInfo installed;
        try {
            installed = pm.getPackageInfo(getContext().getPackageName(), flags);
        } catch (PackageManager.NameNotFoundException e) {
            throw new IllegalArgumentException("Cannot read the installed version");
        }
        final long archiveCode = PackageInfoCompat.getLongVersionCode(archive);
        if (archiveCode <= PackageInfoCompat.getLongVersionCode(installed)) throw new IllegalArgumentException("Downloaded update is not newer than the installed version");
        if (expectedVersionCode > 0 && archiveCode != expectedVersionCode) throw new IllegalArgumentException("Downloaded update does not carry the version the manifest announced");

        final Set<String> want = signers(installed);
        final Set<String> got = signers(archive);
        if (want != null && got != null && !got.containsAll(want)) throw new IllegalArgumentException("Downloaded update is signed with another key; refused");
        if (got == null) Log.w(TAG, "could not read the archive's signers; the system installer will check them");
        return apk;
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signers(PackageInfo info) {
        Signature[] sigs = null;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            sigs = info.signingInfo.hasMultipleSigners() ? info.signingInfo.getApkContentsSigners() : info.signingInfo.getSigningCertificateHistory();
        }
        if ((sigs == null || sigs.length == 0) && info.signatures != null) sigs = info.signatures;
        if (sigs == null || sigs.length == 0) return null;
        final Set<String> out = new HashSet<>();
        for (Signature sig : sigs) out.add(sig.toCharsString());
        return out;
    }
}
