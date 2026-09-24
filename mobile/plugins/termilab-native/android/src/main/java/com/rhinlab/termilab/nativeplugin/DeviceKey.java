package com.rhinlab.termilab.nativeplugin;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import android.util.Base64;
import android.util.Log;
import java.io.File;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The device key (DSK) behind Node's safeStorage, kept wrapped by a
 * non-exportable AES-256 key in the Android Keystore (StrongBox when the device
 * has one; no user authentication, so the app can start Node unattended).
 *
 * Wrapped form in private SharedPreferences: base64(iv(12) | AES-GCM(dsk) | tag).
 * The plain DSK only ever exists in memory and in the environment of the Node
 * thread (TERMILAB_DSK), which mobile/node/main.js deletes before loading
 * anything else. Policy (migration, failures) is in {@link DeviceKeyResolver}.
 *
 * Call it off the main thread: the Keystore can take hundreds of ms (StrongBox).
 */
public final class DeviceKey {

    static final String TAG = "TermilabDeviceKey";
    static final String KEY_ALIAS = "termilab-device-key-wrap";
    static final String PREFS = "termilab_device_key";
    static final String PREF_WRAPPED = "wrapped_dsk";
    /** Phase 1 wrote the DSK here in the clear (DATADIR of the Node plugin). */
    static final String LEGACY_FILE = "nodejs/data/device-key.json";

    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    private DeviceKey() {}

    /** Base64 of the 32-byte DSK, or null if even a fresh one could not be made. */
    public static String load(Context context) {
        final Context app = context.getApplicationContext();
        final SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        final KeystoreWrapper wrapper = new KeystoreWrapper(app);
        try {
            final DeviceKeyResolver.Result r = DeviceKeyResolver.resolve(
                wrapper,
                new DeviceKeyResolver.Store() {
                    @Override
                    public String get() {
                        return prefs.getString(PREF_WRAPPED, null);
                    }

                    @Override
                    public boolean put(String value) {
                        // commit(), not apply(): the legacy file is deleted right after.
                        return prefs.edit().putString(PREF_WRAPPED, value).commit();
                    }
                },
                new DeviceKeyResolver.Codec() {
                    @Override
                    public String encode(byte[] bytes) {
                        return Base64.encodeToString(bytes, Base64.NO_WRAP);
                    }

                    @Override
                    public byte[] decode(String text) {
                        return Base64.decode(text, Base64.DEFAULT);
                    }
                },
                new File(app.getFilesDir(), LEGACY_FILE),
                new SecureRandom(),
                new DeviceKeyResolver.Log() {
                    @Override
                    public void info(String message) {
                        Log.i(TAG, message);
                    }

                    @Override
                    public void warn(String message, Throwable error) {
                        Log.w(TAG, message + (error != null ? ": " + error : ""));
                    }
                }
            );
            Log.i(TAG, "device key: " + r.outcome + (r.persisted ? "" : " (NOT persisted)") + ", " + wrapper.describe());
            return Base64.encodeToString(r.dsk, Base64.NO_WRAP);
        } catch (Exception e) {
            Log.e(TAG, "device key unavailable", e);
            return null;
        }
    }

    static final class KeystoreWrapper implements DeviceKeyResolver.Wrapper {

        private final Context context;

        KeystoreWrapper(Context context) {
            this.context = context;
        }

        private KeyStore keyStore() throws Exception {
            final KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            return ks;
        }

        private SecretKey key() throws Exception {
            final KeyStore ks = keyStore();
            if (ks.containsAlias(KEY_ALIAS)) {
                final KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
                if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                ks.deleteEntry(KEY_ALIAS);
            }
            final boolean strongBox = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                && context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE);
            if (strongBox) {
                try {
                    return generate(true);
                } catch (Exception e) {
                    if (!(e instanceof StrongBoxUnavailableException)) Log.w(TAG, "StrongBox key failed, using TEE: " + e);
                }
            }
            return generate(false);
        }

        private SecretKey generate(boolean strongBox) throws Exception {
            final KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false);
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true);
            final KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(spec.build());
            return gen.generateKey();
        }

        @Override
        public byte[] wrap(byte[] plain) throws Exception {
            final Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            final byte[] iv = c.getIV();
            if (iv == null || iv.length != GCM_IV_BYTES) throw new IllegalStateException("unexpected GCM IV length");
            final byte[] ct = c.doFinal(plain);
            final byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return out;
        }

        @Override
        public byte[] unwrap(byte[] wrapped) throws Exception {
            if (wrapped == null || wrapped.length <= GCM_IV_BYTES) throw new IllegalArgumentException("wrapped device key too short");
            if (!keyStore().containsAlias(KEY_ALIAS)) throw new IllegalStateException("Keystore key missing (restored backup?)");
            final Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, wrapped, 0, GCM_IV_BYTES));
            return c.doFinal(wrapped, GCM_IV_BYTES, wrapped.length - GCM_IV_BYTES);
        }

        @Override
        public void reset() throws Exception {
            final KeyStore ks = keyStore();
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
        }

        /** "StrongBox" / "TEE" / "software", for the log. */
        String describe() {
            try {
                final SecretKey k = key();
                final SecretKeyFactory f = SecretKeyFactory.getInstance(k.getAlgorithm(), "AndroidKeyStore");
                final KeyInfo info = (KeyInfo) f.getKeySpec(k, KeyInfo.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    switch (info.getSecurityLevel()) {
                        case KeyProperties.SECURITY_LEVEL_STRONGBOX:
                            return "wrap key in StrongBox";
                        case KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT:
                            return "wrap key in TEE";
                        case KeyProperties.SECURITY_LEVEL_SOFTWARE:
                            return "wrap key in software keystore";
                        default:
                            return "wrap key security level " + info.getSecurityLevel();
                    }
                }
                return info.isInsideSecureHardware() ? "wrap key in secure hardware" : "wrap key in software keystore";
            } catch (Exception e) {
                return "wrap key level unknown";
            }
        }
    }
}
