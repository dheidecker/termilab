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

## Módulos nativos

- El `postinstall` (`electron-builder install-app-deps`) recompila `node-pty` y
  `cpu-features`. **Después de un build universal, `node_modules` queda con la
  ÚLTIMA arquitectura que se compiló** — que es arm64, porque el universal hace
  x64 primero y arm64 después. Cómodo: el dev local sigue funcionando sin
  reinstalar. Si algún día se invierte el orden, habría que recompilar antes de
  `npm run dev`.

## Sin comprobar todavía

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
