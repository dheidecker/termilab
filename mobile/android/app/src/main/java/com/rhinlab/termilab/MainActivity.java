package com.rhinlab.termilab;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.rhinlab.termilab.nativeplugin.DeviceKey;
import java.util.HashMap;
import java.util.Map;
import net.hampoelz.capacitor.nodejs.CapacitorNodeJS;

public class MainActivity extends BridgeActivity {

    /** Debug builds only: `am start ... --es TERMILAB_SYNC_URL http://127.0.0.1:8787` (with adb reverse) to test against a local sync server. */
    private static final String EXTRA_SYNC_URL = "TERMILAB_SYNC_URL";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        final boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        final String syncUrl = debuggable && getIntent() != null ? getIntent().getStringExtra(EXTRA_SYNC_URL) : null;

        // Before super.onCreate(): that is when the Node plugin loads and starts
        // its engine thread, which calls this provider just before node::Start.
        // Node only starts once per process; a recreated activity re-sets it harmlessly.
        CapacitorNodeJS.setEnvProvider(context -> {
            final Map<String, String> env = new HashMap<>();
            final String dsk = DeviceKey.load(context);
            if (dsk != null) env.put("TERMILAB_DSK", dsk);
            if (syncUrl != null && !syncUrl.isEmpty()) env.put("TERMILAB_SYNC_URL", syncUrl);
            return env;
        });
        super.onCreate(savedInstanceState);
    }
}
