# Termilab para Android — plan

Decidido por el dueño (2026-09-23): APK por GitHub Releases con
auto-actualización (sin Play Store). v1 = hosts/grupos, terminal SSH, sync con
passphrase, known hosts, snippets, logs, auto-update. Fuera de v1: SFTP, port
forwarding, terminal local, split panes.

## Arquitectura

- **Capacitor 8** (JDK 21, compile/targetSdk 36, AGP 8.13) envuelve el mismo
  renderer `src/`.
- **nodejs-mobile** corre los servicios de `electron/services/` sin forkearlos:
  mismo sync, mismo crypto, mismo protocolo que escritorio byte a byte.
  Puente: fork vendorizado de Capacitor-NodeJS beta.10 en
  `mobile/vendor/capacitor-nodejs/` (MIT; el autor ya no lo recomienda para
  proyectos nuevos) + `libnode.so` de nodejs-mobile `main` alineado a 16 KB.
  Solo arm64-v8a en release; x86_64 para el emulador.
- **`electron/` no cambia.** `mobile/node/electron-shim.js` stubea `electron`
  (como hace `scripts/check-main.js`): `app.getPath` → `bridge.getDataPath()`,
  `ipcMain` alimentado por mensajes `ipc:invoke`, ventana falsa cuyo
  `webContents.send` postea `ipc:event`, `shell.openExternal` →
  `native:open-url` (Custom Tab), `safeStorage` = AES-256-GCM con una clave de
  dispositivo (DSK) que Kotlin guarda envuelta por Android Keystore y pasa a
  Node por env al arrancar (se borra de `process.env` antes de cargar nada).
  Parchear `os.hostname()` (en Android da "localhost") y `os.userInfo()`.
- **Renderer:** `vite.mobile.config.js` → `dist-mobile/`; entrada
  `mobile/web/entry.jsx` instala un `window.electronAPI` con la misma forma que
  `preload.js` sobre el puente. `src/platform.js` (`IS_ANDROID`) oculta lo que
  no va en v1. Layout móvil: navegación abajo, editor a pantalla completa, fila
  de teclas Ctrl/Esc/Tab/flechas, `visualViewport` → `fit()`.
- **Updates:** assets `Termilab-<v>-android-arm64.apk` + `latest-android.json`
  `{version, versionCode, file, sha256, size}`; versionCode =
  `major*1e6 + minor*1e3 + patch` desde `package.json`. Node implementa
  `updater:*` con los mismos eventos que `main.js`; Kotlin instala con
  FileProvider + `REQUEST_INSTALL_PACKAGES`.
- **Firma:** keystore único fuera del repo (`~/.config/termilab/termilab-release.jks`),
  contraseñas en el gestor del dueño. **Si se pierde, no hay más updates.**

## Fases (cada una con su verificación)

0. Toolchain + spike go/no-go: scrypt con los parámetros del vault, handshake
   ssh2 sin addons nativos, alineación 16 KB (`readelf -lW`), teclado en xterm.
1. Adaptador Node + modo "mobile" en `check-main.js` (Node 18) con prueba de
   interoperabilidad escritorio↔móvil; `git diff electron/` vacío.
2. Shim del renderer + build móvil; check que cada canal de `preload.js` esté
   en el shim o en la lista de omitidos.
3. Nativo: Keystore/DSK, `allowBackup=false`, login Google por Custom Tab,
   foreground service con sesiones abiertas.
4. UI móvil.
5. Updater, firma, `npm run android:apk`, release junto al escritorio.

## Riesgos

1. **Runtime sin soporte:** Node 18 / OpenSSL 3.0 fuera de soporte y el puente
   deprecado. La costura `window.electronAPI` permite cambiar a backend Kotlin
   (sshj + port JS) sin tocar `src/`.
2. xterm.js con teclados Android (predictivo, composición) — probar en fase 0.
3. Doze mata sockets: sin foreground service las sesiones mueren.
4. Keystore perdido = fin de updates; la verificación de desarrollador de
   Google (global en 2027) ata la misma clave.
5. `libnode.so` sin alinear a 16 KB falla en dispositivos nuevos.
6. El shim puede divergir de `preload.js`: solo lo caza el check.

Toolchain local: `~/Android/jdk` (Temurin 21), `~/Android/Sdk`
(`JAVA_HOME`/`ANDROID_HOME` apuntando ahí). `/dev/kvm` accesible → emulador.

## Resultado fase 0

Spike desechable (2026-09-23) en el scratchpad de la sesión, `android-spike/`; nada del repo cambió
salvo esta sección. Emulador android-36 google_apis x86_64 (KVM): los tiempos son de x86 y no de un
teléfono arm64.

- **Build — PASS.** Capacitor 8.5.2 + Capacitor-NodeJS 1.0.0-beta.10 vendorizado (tgz del release, `dist/`
  precompilado), AGP 8.13 / Gradle 8.14.3 / NDK 28.2. Hay que fijar `ndkVersion` en el plugin **y** en
  `app/`; si no, "Unable to strip" y las libs van sin strip.
- **Arranque de Node — PASS.** De `START` de la activity al primer resultado: 4,6 s (6,0 s en la primera
  apertura tras instalar). Node solo, lanzado a mano, tarda 129 ms: la demora está en el plugin/WebView.
  `whenReady` llega 190–317 ms después de cargar la página.
- **scrypt N=2^17 r=8 p=1 — PASS**, 1,26–2,07 s en la app (compite con el arranque del WebView), 535 ms
  solo; escritorio 426 ms. `deriveVaultKey` del repo: 537–899 ms.
- **ssh2 1.17 — PASS**, `spike-ok` recibido. curve25519-sha256@libssh.org / ssh-ed25519 /
  aes128-gcm@openssh.com; `bindingAvailable=false`, sin cpu-features (JS puro). chacha20-poly1305
  forzado (poly1305 en JS): PASS.
- **Crypto — PASS, byte a byte con escritorio**, usando `crypto-service.js` y `pairing-crypto.js` del repo
  sin tocar: un vault creado en escritorio se abre en Android, los dígitos de pairing coinciden (210691),
  la clave de sesión también, una clave maestra sellada en escritorio se abre en el dispositivo, y un
  ciphertext alterado se rechaza.
- **xterm 5.5 — ida y vuelta PASS; teclado por defecto FAIL.** Con Gboard, "echo hola" llega como
  "echo holalaa", se pierde una letra y aparece un DEL de más tras Enter. Con autocorrect/autocomplete
  en off en el textarea mejora a medias: la primera palabra sigue duplicada ("ecchho").
  `android.captureInput: true` da entrada exacta byte a byte (DEL, TAB, `ESC[D`), pero vale para todo el
  WebView.
- **16 KB — la release de nodejs-mobile v18.20.4 NO** (LOAD 0x1000). En kernel de 16 KB falla con
  `program alignment (4096) cannot be smaller than system page size (16384)`. **El `18.20.4+16kb-fix` que
  trae el plugin beta.10 SÍ** (0x4000): en kernel de 16 KB pasan todos los checks (dlopen + `node::Start`).
  `libnative-lib`/`libc++_shared` en 0x4000 y `zipalign -P 16` OK. **No hace falta compilar Node.**
- **Tamaño del APK:** release arm64 54,8 MB (x86_64 59,4 MB). `libnode.so` pesa 50 MB y va sin comprimir.
  Con `useLegacyPackaging` se estiman unos 22 MB (no medido). Debug arm64: 77 MB.

Capturas: `android-spike/shots/01..05-*.png`; 16 KB en `android-spike/native16k/result.txt`.

**Pendientes (ninguno bloquea):**
1. Teclado: en v1, `captureInput` o una subclase de `CapacitorWebView` que cambie el InputConnection
   solo cuando la terminal tiene el foco (los formularios conservan acentos y dictado). Hay que probarlo
   tecleando de verdad en un teléfono: `adb input` no equivale a teclear.
2. El puente pierde los mensajes que Node envía antes de que la web registre su listener (se perdieron
   los primeros). El shim necesita cola y handshake.
3. La UI no corre en la imagen de 16 KB x86_64 en modo headless: surfaceflinger entra en bucle de
   caídas con swiftshader y con guest. Probar en un dispositivo arm64 real.
4. Medir scrypt y el arranque en un arm64 real.
5. Cosmético: el plugin redirige a logcat todo el stderr del proceso (logs de GL del WebView incluidos)
   con la etiqueta `NodeJS-Engine`.

**Recomendación: GO**, con la arquitectura del plan y el libnode de 16 KB del plugin beta.10.

## Estado fases 1–2

Hecho en `feat/android` (2026-09-24). `git diff main -- electron/` sigue vacío.

- **Layout:** `capacitor.config.json` (appId `com.termilab.app`, `webDir: dist-mobile`,
  `android.path: mobile/android`, `loggingBehavior: none`), `vite.mobile.config.js`,
  `mobile/web/` (entry + shim + `mobile.css`), `mobile/node/` (main + electron-shim),
  `mobile/android/` (proyecto Capacitor, commiteado), plugin vendorizado en
  `mobile/vendor/capacitor-nodejs/` (libnode fuera de git: `scripts/fetch-libnode.js`).
- **Scripts:** `mobile:web`, `mobile:node`, `android:sync`, `android:debug`
  (`TERMILAB_ABI=arm64-v8a` para un teléfono). Capacitor y esbuild solo en devDependencies.
- **Puente:** protocolo `bridge:hello/ready` + `ipc:invoke/reply/send/event` +
  `native:open-url`, documentado en `mobile/node/main.js`. Cola en los dos sentidos;
  `ssh:data` en lotes de 8 ms por sesión (400 paquetes → ≤40 mensajes).
- **DSK (fase 1):** `safeStorage` = AES-256-GCM (`0x01|nonce|tag|ct`). Clave de
  `TERMILAB_DSK` (se borra de `process.env` antes de cargar nada) o, si falta,
  `<datos>/device-key.json` generado al vuelo. **Provisional: fase 3 la mueve a Keystore.**
- **Teclado:** `android.captureInput: true` (hallazgo #1). Vale para todo el WebView:
  sin autocorrección, dictado ni composición también en formularios. La alternativa
  acotada (InputConnection solo con la terminal enfocada) es trabajo nativo de fase 3/4.
- **Gating (`src/platform.js`):** fuera en Android los controles de ventana, Port
  Forwarding, SFTP, terminal local (+, botón, Ctrl+T, reabrir desde Logs), split panes,
  importar known_hosts y claves por archivo. Sidebar colapsado por defecto en Android.
- **Verificación:** `npx -y -p node@18 node scripts/check-mobile.js` (9 comprobaciones,
  con controles negativos probados); `node scripts/check-main.js` sigue en verde.
  Emulador: host creado a mano, aviso de clave, `echo mobile-ok` visible.
- **APK debug x86_64:** 60,7 MB.

Trampas encontradas:
1. Android recrea la activity **en el mismo proceso** (atrás + reabrir) y el plugin
   arrancaba Node otra vez → SIGTRAP nativo. El fork hace el motor por proceso
   (`CapacitorNodeJS` estático) y la página nueva se reconecta con su hello.
2. Capacitor en debug volcaba a logcat cada resultado de plugin (IPC entero, incluidas
   respuestas con contraseñas): `loggingBehavior: none`.
3. npm instala las devDependencies de una dependencia `file:` (eslint, rollup…): se
   quitaron del `package.json` vendorizado.
4. El `dist/` del `.gitignore` raíz escondía el JS precompilado del plugin: excepción explícita.

Pendiente: el botón atrás cierra la app; el formulario de host no hace scroll al campo
enfocado sobre el teclado; `allowBackup=false` (fase 3; hoy la DSK de respaldo iría en
un backup); el copy de Known Hosts sigue citando `~/.ssh/known_hosts`.

## Estado fase 3

Hecho en `feat/android` (2026-09-24). `git diff main -- electron/` sigue vacío.

- **appId `com.rhinlab.termilab`** (decisión del dueño): `capacitor.config.json`, Gradle
  `namespace`/`applicationId`, paquete Java, strings. El `build.appId` de `package.json`
  (`com.termilab.app`) es el de **escritorio** y no se tocó: cambiarlo cambia la identidad
  del instalador de Windows/macOS.
- **Plugin propio `mobile/plugins/termilab-native/`** (Java, dependencia `file:`; cap sync
  lo registra). `DeviceKey` + `DeviceKeyResolver`, `SessionService`, `TerminalInputWebView`,
  `TermilabNativePlugin` (`setSessionCount`, `setTerminalInput`, `exitApp`, evento
  `backButton`). La política de la DSK está en `DeviceKeyResolver`, sin Android, con JUnit:
  `cd mobile/android && ./gradlew :termilab-native:testDebugUnitTest` (7 casos).
- **DSK en Keystore:** clave AES-256 no exportable (`termilab-device-key-wrap`, StrongBox si
  hay, sin autenticación de usuario) que envuelve una DSK aleatoria de 32 bytes con AES-GCM;
  el envoltorio va en `shared_prefs/termilab_device_key.xml`. `MainActivity` registra, antes
  de `super.onCreate()`, un `EnvProvider` en el plugin de Node vendorizado
  (`CapacitorNodeJS.setEnvProvider`): corre en el hilo del motor justo antes de
  `node::Start` y mete `TERMILAB_DSK`. Node ya **no** tiene respaldo en archivo: sin DSK,
  `safeStorage` no está disponible y el login se niega. Un `device-key.json` de fase 1 se
  envuelve, se persiste (`commit()`) y **solo entonces** se borra. Si el unwrap falla
  (backup restaurado, clave invalidada, envoltorio corrupto) → DSK nueva y clave de Keystore
  nueva; lo sellado no se abre, se vuelve a entrar y sale la tarjeta de desbloqueo.
  Probado en el emulador: `MIGRATED_FROM_FILE` + token del login desellado en el host con
  la clave del archivo; envoltorio corrompido → `RECREATED_AFTER_UNWRAP_FAILURE` → login →
  "Unlock this computer" → passphrase → desbloqueado. En el emulador la clave queda en
  "software keystore" (no hay TEE emulado); en un teléfono debería decir TEE o StrongBox
  (logcat `TermilabDeviceKey`).
- **Backups:** `allowBackup="false"`, `fullBackupContent` y `dataExtractionRules` excluyen
  todos los dominios. `bmgr backupnow` → "Backup is not allowed"; el paquete no tiene el flag
  `ALLOW_BACKUP`.
- **Login Google:** `native:open-url` → `@capacitor/browser` (Custom Tab), solo `https:`.
  Contra `https://termilab.rhinlab.com` la Custom Tab abre `accounts.google.com` ("continue
  to rhinlab.com") y el sondeo sigue vivo con la app detrás (77 s comprobados). Al terminar
  el login (bien o mal) la pestaña se cierra sola. **Falta que el dueño complete el login en
  un teléfono.**
- **Foreground service** (`specialUse`, con la propiedad del subtipo): Node cuenta las
  sesiones del `Map` de `ssh-service` (envuelve `ssh:connect`/`ssh:disconnect` y mira
  `ssh:close`/`ssh:error`) y manda `native:sessions {count, signingIn}`; la página lo pasa a
  `setSessionCount`. Notificación "Termilab — N sessions active"; `POST_NOTIFICATIONS` se
  pide una vez, con la primera sesión. Emulador: 2 min 35 s en segundo plano (34 s en Doze
  forzado), mismo pid, `curProcState=4` (FGS), la sesión sigue haciendo eco al volver;
  `exit` remoto y cerrar la pestaña paran el servicio.
- **Atrás:** pila `src/hooks/useBackHandler.js`. Primero lo abierto (formulario de host,
  drawer de known host, aviso de clave de host = Cancel, formulario de snippet, modales de
  claves, menús, búsqueda y grupo abierto en Hosts), luego `useBackFallback` de `App`:
  sidebar desplegado → plegado, pestaña de sesión → Hosts, otra sección → Hosts; en Hosts →
  `moveTaskToBack` (el proceso sigue, comprobado).
- **Teclado:** `captureInput` fuera. `TerminalInputWebView` (sustituye al WebView de
  Capacitor redefiniendo `capacitor_bridge_layout_main.xml` en `app/`) da al IME la
  `BaseInputConnection` de captureInput **solo** con el textarea de xterm enfocado
  (focusin/focusout → `setTerminalInput` → `restartInput`). dumpsys: terminal
  `inputType=0x0`, formulario `inputType=0xc0a1` (texto con autocorrección). Con toques
  reales en Gboard: "Camión" entra en el formulario (pulsación larga en la o → ó);
  en la terminal los toques llegan byte a byte, sin duplicados. `adb shell input text` con
  no-ASCII revienta en el propio `input` (NullPointerException), no llega a la app.
- **Campo sobre el teclado:** Capacitor rellena la ventana con la altura del IME, así que el
  WebView encoge; `entry.jsx` hace `scrollIntoView({block:'center'})` del campo enfocado si
  queda fuera del `visualViewport`.
- **Known Hosts:** en Android el vacío dice que las claves llegan por sync, sin
  `~/.ssh/known_hosts`.
- **Verificación:** `npm run build` y `node scripts/check-main.js` en verde;
  `npx -y -p node@18 node scripts/check-mobile.js` 12/12 (nuevos M9–M11 y `native:sessions`
  en M4/M5; control negativo con el shim de fase 2 y sin el recuento → 3 rojos).
  Capturas en el scratchpad de la sesión, `android-p3/`.

Trampas encontradas:
1. **Android 15+ corta la red de un proceso en caché** (`resolv: network access blocked`).
   Con la Custom Tab delante, Termilab pasa a `procState 15` y `/auth/poll` muere con
   "fetch failed" a los ~7 s. Por eso el servicio también corre mientras hay un login en
   vuelo, y arranca **antes** de abrir la URL (luego ya estaríamos en segundo plano).
2. La notificación del servicio que se publica antes de que el usuario conteste a
   `POST_NOTIFICATIONS` se pierde; al conceder hay que volver a publicarla (`repost`).
3. `adb shell input text` justo después de un toque en un campo puede perderse: el IME
   aún no tiene la conexión nueva. Esperar ~1 s.
4. En el emulador `127.0.0.1:8787` ya estaba ocupado en el host: el servidor de sync falso
   va en otro puerto con `adb reverse`, y la app de debug lo toma de
   `am start ... --es TERMILAB_SYNC_URL http://127.0.0.1:<puerto>` (solo si es depurable).

Pendiente: completar el login real en un teléfono; si el usuario vuelve de la Custom Tab
sin terminar, el sondeo (y la notificación "signing in") dura hasta 10 min — hace falta un
"cancelar" visible (fase 4); el copy "Unlock this computer" dice *computer* en Android.
