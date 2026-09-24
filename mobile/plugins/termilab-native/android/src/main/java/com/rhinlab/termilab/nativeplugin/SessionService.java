package com.rhinlab.termilab.nativeplugin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that exists only while at least one SSH session is open,
 * or while a sync login polls the server (the Custom Tab has the screen, and
 * Android 15+ blocks the network of a cached process).
 *
 * Node runs as a thread of the app process. With the app in the background and
 * no foreground service, Android caches the process (Android 11+ freezes cached
 * apps outright) and Doze cuts its network: the SSH sockets die. A foreground
 * service keeps the process at foreground-service priority, unfrozen and on the
 * network. Type specialUse: none of the typed categories covers "an interactive
 * remote shell the user left open".
 *
 * Driven by {@link TermilabNativePlugin#setSessionCount}: count > 0 starts or
 * updates it, 0 stops it. Starting only ever happens from the foreground (the
 * user just connected); later updates go straight to the running instance, so
 * no background-start restriction applies.
 */
public class SessionService extends Service {

    static final String TAG = "TermilabSessions";
    static final String CHANNEL_ID = "termilab-sessions";
    static final int NOTIFICATION_ID = 4101;

    private static volatile SessionService running;
    /** The last state asked for: a stop that lands before onStartCommand still wins. */
    private static volatile int desired = 0;
    private static volatile boolean desiredSigningIn = false;
    private int count = -1;
    private boolean signingIn = false;

    /** Start, update or stop. Safe from any thread. */
    static void apply(Context context, int count, boolean signingIn) {
        final Context app = context.getApplicationContext();
        desired = Math.max(count, 0);
        desiredSigningIn = signingIn;
        final SessionService svc = running;
        if (!wanted()) {
            if (svc != null) svc.stop();
            return;
        }
        if (svc != null) {
            svc.update(desired, signingIn);
            return;
        }
        final Intent intent = new Intent(app, SessionService.class);
        try {
            ContextCompat.startForegroundService(app, intent);
        } catch (Exception e) {
            // ForegroundServiceStartNotAllowedException (app already in the background):
            // sessions still work until Android reclaims the process.
            Log.w(TAG, "could not start the sessions service: " + e);
        }
    }

    /**
     * Post the notification again. The first session starts the service before
     * the user has answered the POST_NOTIFICATIONS prompt, and a notification
     * posted while it was denied is dropped, not queued.
     */
    static void repost() {
        final SessionService svc = running;
        if (svc == null) return;
        final NotificationManager nm = (NotificationManager) svc.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, svc.build());
    }

    private static boolean wanted() {
        return desired > 0 || desiredSigningIn;
    }

    static boolean isRunning() {
        return running != null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = this;
        count = desired;
        signingIn = desiredSigningIn;
        ensureChannel();
        final int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        // startForeground first even when about to stop: a service started with
        // startForegroundService() that never calls it crashes the app.
        ServiceCompat.startForeground(this, NOTIFICATION_ID, build(), type);
        if (!wanted()) {
            stop();
            return START_NOT_STICKY;
        }
        Log.i(TAG, "foreground: " + count + " session(s)" + (signingIn ? ", signing in" : ""));
        // Not sticky: if Android kills the process the sessions are gone anyway,
        // and a restarted service with nothing to keep alive would be a lie.
        return START_NOT_STICKY;
    }

    private void update(int n, boolean login) {
        if (n == count && login == signingIn) return;
        count = n;
        signingIn = login;
        final NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, build());
        Log.i(TAG, "updated: " + count + " session(s)" + (signingIn ? ", signing in" : ""));
    }

    private void stop() {
        running = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
        Log.i(TAG, "stopped: no sessions open");
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        final NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        final NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Open sessions", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while SSH sessions stay connected in the background");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification build() {
        final int n = count;
        final Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent open = null;
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        final String text = n > 0
            ? "Termilab — " + n + (n == 1 ? " session active" : " sessions active")
            : "Termilab — signing in to sync";
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.termilab_ic_session)
            .setContentTitle(text)
            .setContentText(n > 0 ? "SSH stays connected while the app is in the background" : "Waiting for the browser sign-in to finish")
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }
}
