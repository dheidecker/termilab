package com.rhinlab.termilab.nativeplugin;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.junit.Before;
import org.junit.Test;

/**
 * DeviceKeyResolver without Android: a JCA AES-GCM key stands in for the
 * Keystore one. Run: ./gradlew :termilab-native:testDebugUnitTest (mobile/android).
 */
public class DeviceKeyResolverTest {

    /** A software "Keystore" whose key can be lost, like after restoring a backup. */
    static final class FakeWrapper implements DeviceKeyResolver.Wrapper {

        SecretKey key;
        int resets = 0;
        boolean failWrap = false;

        SecretKey key() throws Exception {
            if (key == null) {
                final KeyGenerator g = KeyGenerator.getInstance("AES");
                g.init(256);
                key = g.generateKey();
            }
            return key;
        }

        @Override
        public byte[] wrap(byte[] plain) throws Exception {
            if (failWrap) throw new IllegalStateException("keystore broken");
            final Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            final byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            c.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            final byte[] ct = c.doFinal(plain);
            final byte[] out = Arrays.copyOf(iv, 12 + ct.length);
            System.arraycopy(ct, 0, out, 12, ct.length);
            return out;
        }

        @Override
        public byte[] unwrap(byte[] w) throws Exception {
            if (key == null) throw new IllegalStateException("Keystore key missing");
            final Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, w, 0, 12));
            return c.doFinal(w, 12, w.length - 12);
        }

        @Override
        public void reset() {
            resets++;
            key = null;
        }
    }

    static final class MemStore implements DeviceKeyResolver.Store {

        String value;
        boolean failPut = false;

        @Override
        public String get() {
            return value;
        }

        @Override
        public boolean put(String v) {
            if (failPut) return false;
            value = v;
            return true;
        }
    }

    static final DeviceKeyResolver.Codec CODEC = new DeviceKeyResolver.Codec() {
        @Override
        public String encode(byte[] b) {
            return Base64.getEncoder().encodeToString(b);
        }

        @Override
        public byte[] decode(String t) {
            return Base64.getDecoder().decode(t);
        }
    };

    static final DeviceKeyResolver.Log LOG = new DeviceKeyResolver.Log() {
        @Override
        public void info(String m) {}

        @Override
        public void warn(String m, Throwable e) {}
    };

    FakeWrapper wrapper;
    MemStore store;
    File legacy;

    @Before
    public void setUp() throws Exception {
        wrapper = new FakeWrapper();
        store = new MemStore();
        final File dir = java.nio.file.Files.createTempDirectory("dsk").toFile();
        legacy = new File(dir, "device-key.json");
    }

    DeviceKeyResolver.Result resolve() {
        return DeviceKeyResolver.resolve(wrapper, store, CODEC, legacy, new SecureRandom(), LOG);
    }

    void writeLegacy(byte[] key) throws Exception {
        try (FileOutputStream out = new FileOutputStream(legacy)) {
            out.write(("{\"key\":\"" + CODEC.encode(key) + "\",\"note\":\"TODO(fase 3): temporary.\"}").getBytes(StandardCharsets.UTF_8));
        }
    }

    @Test
    public void freshInstallCreatesWrapsAndThenReusesTheSameKey() {
        final DeviceKeyResolver.Result first = resolve();
        assertEquals(DeviceKeyResolver.Outcome.CREATED, first.outcome);
        assertEquals(32, first.dsk.length);
        assertTrue(first.persisted);
        assertNotNull(store.value);
        assertFalse("the stored value must not be the plain DSK", store.value.equals(CODEC.encode(first.dsk)));

        final DeviceKeyResolver.Result second = resolve();
        assertEquals(DeviceKeyResolver.Outcome.UNWRAPPED, second.outcome);
        assertArrayEquals(first.dsk, second.dsk);
        assertFalse("no device-key.json may be created", legacy.exists());
    }

    @Test
    public void phaseOneFileIsMigratedOnceAndDeleted() throws Exception {
        final byte[] old = new byte[32];
        new SecureRandom().nextBytes(old);
        writeLegacy(old);

        final DeviceKeyResolver.Result r = resolve();
        assertEquals(DeviceKeyResolver.Outcome.MIGRATED_FROM_FILE, r.outcome);
        assertArrayEquals("secrets on disk were sealed with the file's key", old, r.dsk);
        assertFalse("device-key.json must be deleted after migrating", legacy.exists());

        final DeviceKeyResolver.Result again = resolve();
        assertEquals(DeviceKeyResolver.Outcome.UNWRAPPED, again.outcome);
        assertArrayEquals(old, again.dsk);
    }

    @Test
    public void fileIsKeptWhenItsKeyCouldNotBePersisted() throws Exception {
        final byte[] old = new byte[32];
        new SecureRandom().nextBytes(old);
        writeLegacy(old);
        store.failPut = true;

        final DeviceKeyResolver.Result r = resolve();
        assertArrayEquals(old, r.dsk);
        assertFalse(r.persisted);
        assertTrue("deleting the only copy of the key would lose the sealed secrets", legacy.exists());
    }

    @Test
    public void unwrapFailureMakesANewKeyAndResetsTheWrapKey() {
        final byte[] first = resolve().dsk;
        wrapper.key = null; // restored backup: prefs came back, the Keystore key did not

        final DeviceKeyResolver.Result r = resolve();
        assertEquals(DeviceKeyResolver.Outcome.RECREATED_AFTER_UNWRAP_FAILURE, r.outcome);
        assertFalse(Arrays.equals(first, r.dsk));
        assertTrue(r.persisted);
        assertEquals(1, wrapper.resets);
        assertArrayEquals("the new key must survive the next start", r.dsk, resolve().dsk);
    }

    @Test
    public void corruptWrappedValueIsTreatedLikeAFailedUnwrap() {
        resolve();
        final byte[] w = CODEC.decode(store.value);
        w[w.length - 1] ^= 1;
        store.value = CODEC.encode(w);
        assertEquals(DeviceKeyResolver.Outcome.RECREATED_AFTER_UNWRAP_FAILURE, resolve().outcome);
    }

    @Test
    public void garbageLegacyFileIsDeletedAndIgnored() throws Exception {
        try (FileOutputStream out = new FileOutputStream(legacy)) {
            out.write("{\"key\":\"c2hvcnQ=\"}".getBytes(StandardCharsets.UTF_8));
        }
        final DeviceKeyResolver.Result r = resolve();
        assertEquals(DeviceKeyResolver.Outcome.CREATED, r.outcome);
        assertFalse(legacy.exists());
    }

    @Test
    public void readLegacyReturnsNullWithoutFile() {
        assertNull(DeviceKeyResolver.readLegacy(legacy, CODEC, LOG));
    }
}
