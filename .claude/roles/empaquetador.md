# Memoria del rol: empaquetador — Termilab

Primera entrada escrita por el orquestador, no por un subagente de este rol:
son hallazgos de primera mano de la sesión del 2026-09-08, en la que se
construyeron los primeros binarios de macOS del proyecto. Cúralos como los
tuyos — corrige lo que compruebes que ya no es cierto.

## macOS

- **El icono no necesita `.icns`.** electron-builder convierte `assets/icon.png` (512×512) solo.
- **`mac.files` REEMPLAZA a `build.files`, no se suma** (electron-builder 26). Un `mac.files` con
  solo una negación dejó el `app.asar` con el repo entero: `mobile/`, `server/`, `src/`, `.claude/`,
  `docs/`. Toda exclusión va en `build.files`. Tras cualquier cambio de `files`, lista el asar:
  `node -e "require('@electron/asar').listPackage('<app.asar>')"` — debe tener solo `assets dist
  electron node_modules package.json` (~1017 entradas en 1.15.0).
- **El universal necesita dos ajustes desde builder 26 + node-pty 1.1.0** (ambos en `package.json`
  desde 1.15.0; sin ellos `@electron/universal` 2.0.3 aborta con «same in both x64 and arm64
  builds and not covered by the x64ArchFiles rule»):
  - `mac.x64ArchFiles` para `node-pty/prebuilds/darwin-*/*`. node-pty 1.1.0 trae prebuilds
    single-arch idénticos en ambos builds. No se usan: el loader prueba antes `build/Release`,
    que sí sale fat. Las copias de una sola arquitectura del asar-unpacked son esas, es normal.
  - `!node_modules/ssh2/lib/protocol/crypto/build/**` en `build.files` (vale también para Linux).
- **node-pty 1.1.0 es N-API**: el ABI de Electron ya no es un riesgo para él. `cpu-features` sí
  se recompila por arquitectura y sale fat.
- **Probar node-pty por arquitectura sin UI:** `ELECTRON_RUN_AS_NODE=1 <.app>/Contents/MacOS/Termilab
  test.js` (y con `arch -x86_64` delante para Rosetta), con `require('<app.asar>/node_modules/node-pty')`
  y un `pty.spawn`. Funciona porque el fuse RunAsNode está activo. Si alguien lo apaga, esta
  prueba deja de servir.
- **Arranque aislado:** lanza el binario con `--user-data-dir=<tmp>` para no tocar los datos reales
  de Derek (el store migra y reescribe `settings.json` al leerlo).
- **Cerrar la app:** un `pkill -f` mató al renderer pero el main sobrevivió y relanzó GPU y red.
  Comprueba con `pgrep` y, si hace falta, un segundo `kill` al pid del main.
- **Tamaños y tiempos** (M-series, electron 33.4.11, builder 26.16.1): universal 1.15.0 = 186,9 MB
  (178 MiB); 1.9.1 era 185,6 MB (los «177 MB» de antes eran MiB). ~1 min con Electron en caché.
  `npm install` + rebuild: 5 s.

## Linux (electron-builder 26, desde 2026-09-24)

- **Se subió a electron-builder 26 por pacman.** En 25.x `FpmTarget.supportsAutoUpdate` era solo
  `deb`/`rpm`: el paquete pacman salía sin `package-type`, sin `app-update.yml` y sin entrada en
  `latest-linux.yml`, y además heredaba el `package-type=deb` que el deb deja en el
  `linux-unpacked` compartido. Parchearlo en 25 eran tres hacks; 26 lo hace nativo.
- **Cambios de config que exige 26:** `linux.desktop` va dentro de `desktop.entry`, y
  `win.publisherName` pasó a `win.signtoolOptions.publisherName`. `install-app-deps` sigue
  funcionando igual (ahora vía `@electron/rebuild`).
- **Los depends por defecto de pacman en 26 están mal para nosotros** (`ffmpeg`, `re2`, `c-ares`,
  `libappindicator-gtk3`... copiados del paquete `electron` de Arch, que usa libs del sistema).
  Por eso `build.pacman.depends` es explícito, derivado de `readelf -d` del binario y comprobado
  contra la API de archlinux.org (`mesa` da `libgbm`; `libcups` llega vía `gtk3`).
- **La descripción sale rota en pacman:** fpm recibe `"\n <desc>"` (formato deb) y `.PKGINFO`
  queda con `pkgdesc` vacío. Se arregla con `pacman.fpm: ["--description", ...]` (fpm se queda
  con el último).
- **fpm-pacman necesita `bsdtar`** y no viene empaquetado. Sin sudo en Ubuntu:
  `apt-get download libarchive-tools && dpkg-deb -x *.deb root`, y `root/usr/bin` al `PATH`.
  Compresión por defecto: xz (pacman lo acepta).
- **El `.INSTALL` de pacman no tiene `post_upgrade`**: el symlink `/usr/bin/termilab` y el chmod de
  `chrome-sandbox` solo corren en la primera instalación. En CachyOS da igual (hay userns, el
  archivo ya viaja 0755 y el symlink sobrevive a la actualización), pero no es obvio.
- **El AppImage siempre se construye antes que deb/pacman**, sea cual sea el orden en la CLI, así
  que nunca hereda `package-type`. Comprobado con `--appimage-extract` en `npm run dist`.
- **Tiempos:** los tres targets Linux, ~3,5 min en esta máquina. Tamaños 1.11.1: AppImage 108 MB,
  deb 84 MB, pacman 76 MB.
- **Validar sin pacman:** `tar -xf x.pacman` saca `.PKGINFO`/`.INSTALL`; para arrancar el binario
  sin display, `xvfb-run -a ./termilab --no-sandbox --user-data-dir=<tmp>`. Ojo: puede haber un
  Termilab instalado del dueño corriendo en `/opt/Termilab`, no lo confundas con el tuyo en `pgrep`.

## Módulos nativos

- El `postinstall` (`electron-builder install-app-deps`) recompila `node-pty` y
  `cpu-features`. **Después de un build universal, `node_modules` queda con la
  ÚLTIMA arquitectura que se compiló** — que es arm64, porque el universal hace
  x64 primero y arm64 después. Cómodo: el dev local sigue funcionando sin
  reinstalar. Si algún día se invierte el orden, habría que recompilar antes de
  `npm run dev`.

- **El `sshcrypto.node` de `ssh2` no sirve en Electron, así que ya no se empaqueta.** Se compila
  para Node en `npm install` y `install-app-deps` no lo recompila (su `binding.gyp` no está en la
  raíz). En Electron da «Module did not self-register». ssh2 lo carga en try/catch y cae a crypto
  en JS, que es lo que se ha usado siempre. Excluirlo no cambia el comportamiento. Sin probar:
  recompilarlo para Electron, que sería más rápido.

## Sin comprobar todavía

- **Los builds de Linux con la exclusión de `sshcrypto.node`** (2026-09-25) no se han vuelto a
  generar. Debería dar igual, porque allí tampoco cargaba, pero no está visto. Los dos ajustes
  del universal quedaron sin commitear en `package.json` (rama `main`) y se entregaron al
  orquestador para que decida.

- **pacman en CachyOS real:** instalar con `pacman -U`, el diálogo de pkexec y la actualización
  de extremo a extremo no se han probado; solo se validó el paquete por dentro.

- **Nada está firmado ni notarizado.** Los dmg abren en la máquina donde se
  compilaron porque no llevan el atributo de cuarentena; en cualquier otro Mac
  Gatekeeper los va a bloquear. Hace falta cuenta de Apple Developer.
- **La UI no se ha visto en macOS.** Se verificó que el `.app` arranca (main,
  renderer, GPU y network vivos), no que se renderice bien: el permiso de
  captura de pantalla estaba denegado. `titleBarStyle: 'hidden'` en darwin es
  una ruta de código que nadie ha mirado con los ojos.
- **electron-updater en macOS.** El canal apunta a GitHub Releases y ahí solo
  hay artefactos de Linux. Un `latest-mac.yml` se genera en `release/` con cada
  build, pero nunca se ha publicado ni probado una actualización en Mac.

## Android (fase 5, 2026-09-24)

- **Keystore de release:** la ruta vigente es la del `CLAUDE.md` (`~/.termilab-signing/`); esta
  memoria decía `~/.config/termilab/` (el `userData` de Electron), probablemente la de antes de
  moverla. No comprobado (el clasificador bloquea listar ese directorio). Nunca se regenera si
  existe: otra clave = ninguna instalación puede actualizar.
- `npm run android:apk` = sync + `scripts/android-apk.js`: falla con APK sin firmar o con la
  clave debug; comprueba apksigner, `zipalign -c -P 16` y el LOAD de cada `.so` (parser ELF en JS).
  Variables de prueba: `TERMILAB_VERSION`, `TERMILAB_ABI=x86_64`, `TERMILAB_BUILD_TYPE=updateTest`,
  `TERMILAB_OUT` (nunca publicar esos APK).
- **R8 funciona** con Capacitor 8 + el plugin de Node, pero solo con
  `-keep class net.hampoelz.capacitor.nodejs.** { *; }`: `native-lib.cpp` llama a
  `NodeProcess.nativeReceive` por `GetMethodID`; sin el keep R8 lo quita y Node arranca mudo.
- `useLegacyPackaging=true` (libs comprimidas): 55,1 → 19,7 MB y el 16 KB sigue valiendo
  (zipalign solo mira lo que va sin comprimir; la alineación que importa es la del ELF).
- La prueba e2e del updater: `updateTest` (release + debuggable) versión N-1 → release N por un
  feed local con `adb reverse` y `am start ... --es TERMILAB_UPDATE_URL`. Sustituir una
  debuggable por una no debuggable con la misma firma funciona. Instalar sobre la debug de
  siempre no: otra clave, hay que desinstalar.

## termilab-keeper (binarios ELF para los servidores, 2026-10-02)

- **Rutas en runtime:** escritorio `app.asar/electron/keeper/{manifest.json,bin/}`, leídos con el
  `fs` parcheado de Electron (comprobado con `ELECTRON_RUN_AS_NODE=1 ./termilab script.js`: sha256
  coinciden). Android: el plugin copia `assets/public/nodejs/` a `<filesDir>/nodejs/public/`, así
  que es `path.join(__dirname, 'keeper')` **del bundle**, no `__dirname/../keeper` como en
  escritorio: el servicio necesita las dos rutas.
- **No hace falta `asarUnpack`:** el smart-unpack de electron-builder solo mira archivos con
  `moduleRootPath` (dentro de `node_modules`); un ELF sin extensión en `electron/` se queda en el
  asar. Tampoco los ve la firma de mac (osx-sign recorre el `.app`, no el interior del asar).
- **En el APK van en `assets/`, comprimidos (Defl), nunca en `lib/`:** no los toca strip ni
  zipalign, y `android-apk.js` solo valida `lib/*.so`. El plugin los copia sin bit de ejecución
  (irrelevante: se suben por SFTP).
- **Peso:** 304 KB crudos (4 arquitecturas); ~152 KB en xz (deb/pacman), ~166 KB zstd, ~183 KB
  gzip; en el APK, 190 KB medidos. Estimación por compresión, no diff de dos builds reales.
- **Zig 0.16.0 fijado** en `build-keeper.sh`; con caché caliente el build tarda <1 s y da el mismo
  sha256 (reproducible comprobado).
- **Trampa de worktree: `node_modules` como symlink rompe el empaquetado.** electron-builder 26
  avisa `cannot find path for dependency` y mete 11 de las 32 dependencias de primer nivel
  (faltaban asn1, js-yaml, graceful-fs...): el paquete sale con código 0 y roto. En un worktree,
  copia `node_modules` (`cp -a --reflink=auto`) en vez de enlazarlo, antes de `pack`/`dist`.
- **`npm run android:debug` hace `adb install -r`** en el dispositivo que haya conectado. Para
  solo construir: `npm run android:sync` y luego `./gradlew assembleDebug -PtermilabAbis=...` en
  `mobile/android`.
- **Sin comprobar:** la extracción del keeper en un dispositivo real (se dedujo de
  `CapacitorNodeJS.copyNodeProjectFromAPK` + el listado del APK), y los paquetes de mac/win con el
  keeper dentro (solo se construyó `linux-unpacked`).

## Método de entrada en Linux: IBus fuera (2026-10-02)

- **Quién elige el módulo IM:** GTK3 dentro del proceso main, al **primer foco de un campo de
  texto** (no al arrancar). Por eso `process.env.GTK_IM_MODULE = ...` arriba de `main.js` basta y
  cubre todas las rutas de arranque: no hace falta tocar el `.desktop` ni el AppRun. `XMODIFIERS`
  no influye en esa elección (solo lo usa el módulo `xim`). Medido con `/proc/<pid>/maps`:
  `im-ibus.so` + `libibus-1.0.so` cargados sin el cambio, nada con él.
- **`--disable-gtk-ime` existe en Electron 33 pero NO sirve:** quita también las teclas muertas
  (´ + a da «a»). `gtk-im-context-simple` sí las compone.
- **`/proc/<pid>/environ` no refleja las asignaciones a `process.env`** (es el entorno inicial):
  no lo uses como prueba de que la variable llegó; usa `maps`.
- **Banco de prueba que funciona:** `xvfb-run` + `setxkbmap latam` + `xdotool` real
  (`apt-get download xdotool libxdo3` y `dpkg-deb -x`, `LD_LIBRARY_PATH` a su lib) +
  `--remote-debugging-port` solo para enfocar el input y leer su valor. CDP
  `Input.dispatchKeyEvent` no sirve para esto: entra directo al renderer y se salta el IME del
  proceso main. Sin `ibus-daemon` en el Xvfb, `im-ibus.so` se carga igual (y cae a simple).
- **`pgrep -f <patrón>` dentro de `xvfb-run` casa con el argv del propio xvfb-run** si le pasas el
  patrón como argumento, y el `pkill` se lo lleva. Ánclalo: `"^[^ ]*linux-unpacked/termilab --no-sandbox"`.
- **Un worktree creado con umask 077 tiene las fuentes en 0600**, y el `umask 022` de los scripts
  no lo arregla: electron-builder copia el modo del icono y el `.deb` sale con
  `hicolor/512x512/apps/termilab.png` 0600 (`check-package-perms.js` lo caza). Antes de empaquetar
  en un worktree: `git ls-files -z | xargs -0 chmod a+r`.
- **Sin comprobar:** Wayland nativo (`--ozone-platform=wayland`; Electron 33 arranca en X11 por
  defecto), y que las apps abiertas con `shell.openPath` (editor de sftp-edit) heredan
  `GTK_IM_MODULE=gtk-im-context-simple`; la terminal local no, `local-shell-service` lo borra.
