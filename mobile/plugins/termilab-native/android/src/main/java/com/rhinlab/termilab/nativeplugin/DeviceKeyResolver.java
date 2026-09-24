package com.rhinlab.termilab.nativeplugin;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which device key (DSK) Node gets, with no Android dependency so it runs under
 * plain JUnit (src/test). {@link DeviceKey} plugs in the Keystore wrapper,
 * SharedPreferences and android.util.Base64.
 *
 * The DSK is 32 random bytes; mobile/node/electron-shim.js uses it as the
 * AES-256-GCM key behind safeStorage (sync token, vault master key). At rest it
 * only exists wrapped by a non-exportable Keystore key.
 *
 * Order of precedence:
 *  1. The phase-1 file {@code <DATADIR>/device-key.json}, if a dev install left
 *     one: the data on disk was sealed with it. It is wrapped, persisted, and
 *     only then deleted.
 *  2. The wrapped DSK in preferences, unwrapped by the Keystore key.
 *  3. A new random DSK. Also what happens when unwrapping fails (a restored
 *     backup without its Keystore key, an invalidated key): everything sealed
 *     with the old DSK becomes unreadable, crypto-service's _unwrap() returns
 *     null, and the user signs in / unlocks with the passphrase again.
 */
public final class DeviceKeyResolver {

    public static final int DSK_BYTES = 32;

    /** Wraps and unwraps with the hardware key. reset() drops it so the next wrap makes a new one. */
    public interface Wrapper {
        byte[] wrap(byte[] plain) throws Exception;

        byte[] unwrap(byte[] wrapped) throws Exception;

        void reset() throws Exception;
    }

    /** Where the wrapped DSK lives (base64). put() must be durable before it returns. */
    public interface Store {
        String get();

        boolean put(String value);
    }

    public interface Codec {
        String encode(byte[] bytes);

        byte[] decode(String text);
    }

    public interface Log {
        void info(String message);

        void warn(String message, Throwable error);
    }

    /** What happened, for the log line and the tests. */
    public enum Outcome {
        UNWRAPPED,
        MIGRATED_FROM_FILE,
        CREATED,
        RECREATED_AFTER_UNWRAP_FAILURE,
    }

    public static final class Result {

        public final byte[] dsk;
        public final Outcome outcome;
        public final boolean persisted;

        Result(byte[] dsk, Outcome outcome, boolean persisted) {
            this.dsk = dsk;
            this.outcome = outcome;
            this.persisted = persisted;
        }
    }

    private static final Pattern LEGACY_KEY = Pattern.compile("\"key\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"");

    private DeviceKeyResolver() {}

    public static Result resolve(Wrapper wrapper, Store store, Codec codec, File legacyFile, SecureRandom random, Log log) {
        byte[] dsk = null;
        Outcome outcome;
        boolean mustPersist = true;

        final byte[] legacy = readLegacy(legacyFile, codec, log);
        final String wrapped = store.get();
        boolean unwrapFailed = false;

        if (legacy != null) {
            dsk = legacy;
            outcome = Outcome.MIGRATED_FROM_FILE;
        } else {
            if (wrapped != null && !wrapped.isEmpty()) {
                try {
                    final byte[] plain = wrapper.unwrap(codec.decode(wrapped));
                    if (plain != null && plain.length == DSK_BYTES) dsk = plain;
                    else unwrapFailed = true;
                } catch (Exception e) {
                    unwrapFailed = true;
                    log.warn("wrapped device key did not unwrap; making a new one (sealed secrets are lost)", e);
                }
            }
            if (dsk != null) {
                outcome = Outcome.UNWRAPPED;
                mustPersist = false;
            } else {
                dsk = new byte[DSK_BYTES];
                random.nextBytes(dsk);
                outcome = unwrapFailed ? Outcome.RECREATED_AFTER_UNWRAP_FAILURE : Outcome.CREATED;
            }
        }

        boolean persisted = !mustPersist;
        if (mustPersist) {
            // A failed unwrap may mean the Keystore key itself is gone or invalid:
            // start the wrap key over rather than wrap with a broken one.
            if (unwrapFailed) resetQuietly(wrapper, log);
            persisted = wrapAndStore(wrapper, store, codec, dsk, log);
            if (!persisted) {
                resetQuietly(wrapper, log);
                persisted = wrapAndStore(wrapper, store, codec, dsk, log);
            }
        }

        // The file goes only once its key is safely wrapped: deleting it first and
        // then failing to persist would lose every secret sealed with it.
        if (legacyFile != null && legacyFile.exists() && (legacy == null || persisted)) {
            if (legacyFile.delete()) log.info("deleted " + legacyFile.getName());
            else log.warn("could not delete " + legacyFile.getAbsolutePath(), null);
        }

        return new Result(dsk, outcome, persisted);
    }

    private static boolean wrapAndStore(Wrapper wrapper, Store store, Codec codec, byte[] dsk, Log log) {
        try {
            return store.put(codec.encode(wrapper.wrap(dsk)));
        } catch (Exception e) {
            log.warn("could not wrap the device key", e);
            return false;
        }
    }

    private static void resetQuietly(Wrapper wrapper, Log log) {
        try {
            wrapper.reset();
        } catch (Exception e) {
            log.warn("could not reset the Keystore key", e);
        }
    }

    // java.nio.file is API 26; minSdk is 24.
    private static String readText(File file) throws java.io.IOException {
        try (InputStream in = new FileInputStream(file)) {
            final ByteArrayOutputStream out = new ByteArrayOutputStream();
            final byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** {"key": "<base64 of 32 bytes>", "note": ...} as phase 1 wrote it; null if absent or unusable. */
    static byte[] readLegacy(File file, Codec codec, Log log) {
        if (file == null || !file.exists()) return null;
        try {
            final String text = readText(file);
            final Matcher m = LEGACY_KEY.matcher(text);
            if (!m.find()) return null;
            final byte[] key = codec.decode(m.group(1));
            return key != null && key.length == DSK_BYTES ? key : null;
        } catch (Exception e) {
            log.warn("unreadable " + file.getName(), e);
            return null;
        }
    }
}
