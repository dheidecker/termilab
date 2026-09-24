# Memoria del rol: empaquetador — Termilab

Primera entrada escrita por el orquestador, no por un subagente de este rol:
son hallazgos de primera mano de la sesión del 2026-09-08, en la que se
construyeron los primeros binarios de macOS del proyecto. Cúralos como los
tuyos — corrige lo que compruebes que ya no es cierto.

## macOS

- **Sin identidad de firma, el build falla si no se desactiva la búsqueda.**
  Hay que pasar `CSC_IDENTITY_AUTO_DISCOVERY=false` en el entorno; los scripts
  `dist:mac*` NO lo llevan dentro, se pone al invocarlos.
- **El target `mac: dmg` ya estaba configurado desde antes** y nunca se había
  ejecutado: hasta este commit, solo `dist:all` lo alcanzaba. No es una
  configuración nueva sin probar, es una que no tenía script propio.
- **El icono no necesita `.icns`.** electron-builder convierte
  `assets/icon.png` (512×512) por su cuenta y no protesta.
- **El universal sale bien y sin trucos.** `--mac dmg --universal` recompila
  los nativos para x64 y arm64 por separado y los fusiona. Verificado con
  `lipo -archs`: tanto el binario principal como el `.node` de `node-pty`
  quedan fat. Dentro del `.app` aparecen además copias de una sola
  arquitectura — es normal, las deja `@electron/universal` en el
  asar-unpacked, no es un fallo.
- **Tamaños y tiempos de referencia** (M-series, electron 33.4.11): arm64 ≈ 99
  MB y menos de un minuto; universal ≈ 177 MB y unos dos. El universal
  descarga los dos Electron, así que la primera vez tarda más.

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

- **`ssh2` viaja con su `sshcrypto.node` compilado para Node (ABI 137), no para Electron (130).**
  `install-app-deps` no lo recompila (su `binding.gyp` no está en la raíz del paquete). ssh2 lo
  carga en try/catch y cae a crypto en JS, así que no rompe, pero es más lento. Ya pasaba con 25.

## Sin comprobar todavía

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

- **Keystore de release:** `~/.config/termilab/termilab-release.jks` + `keystore.properties` (600).
  Nunca se regenera si existe: otra clave = ninguna instalación puede actualizar. Ese directorio
  es también el `userData` de Electron.
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
