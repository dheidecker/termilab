# Memoria del rol: disenador — Termilab

Lee el `CLAUDE.md` de la raíz antes de tocar nada, y escribe aquí antes de
entregar.

## Android (fase 4, 2026-09-24; lo anotó dev-frontend)

- La UI móvil usa **los mismos tokens** de `src/index.css`; no hay paleta propia. Tema claro y
  oscuro se probaron en el emulador. Si cambias un token, mira también Android.
- Detrás de la barra de estado y de la de gestos se ve la ventana nativa: `entry.jsx` le pone
  `--bg-primary` y el estilo de iconos según `data-theme`. Por eso la barra inferior y las barras
  superiores van en `--bg-primary` (la cabecera de sesión y la fila de teclas en
  `--bg-secondary`). Un token de fondo nuevo para esas barras rompe la continuidad con la ventana.
- Mínimos táctiles: 44px. Los controles de escritorio más pequeños se agrandan en
  `mobile/web/mobile.css` (con `html[data-platform='android']`), no en su CSS.
- Ctrl/Alt: `m-key-armed` (borde + tinte) = solo la próxima tecla; `m-key-locked` (relleno de
  acento) = bloqueado. Que no se parezcan es a propósito.

## SFTP (2026-09-24, lo anotó dev-frontend)

- `src/components/SFTP/SFTP.css` usa solo tokens; los colores de tipo de fichero salen de los de estado
  (carpeta `--accent`, archivo comprimido `--color-warning`, código/ejecutable `--color-success`, imagen
  `--color-info`, PDF `--color-danger`), que ya tienen versión clara. Capturas de los dos temas en el
  scratchpad de esa sesión (`sftp/01`, `02`, `09`).
- Los modales SFTP van en z-index 5500, por debajo del de host key (6000): una conexión puede pedir la
  clave con un diálogo SFTP abierto.

## Color de terminal visible (2026-09-25, lo anotó dev-frontend)

- Toda la matemática está en `src/themes/tint.js` (pura; la mide `scratchpad/alias/contrast.mjs`).
  El contraste solo depende de la luminancia: el fondo teñido se **devuelve a la luminancia del
  esquema** manteniendo el tono cuando la mezcla rompe una regla. Por eso Dracula/Monokai/Nord
  (un ANSI a 3.0x:1) se tiñen igual, pero se ve menos (ΔE OKLab ~2–3 frente a 4–7 en GitHub Dark).
- Reglas: fg >= 4.5 (o lo que tuviera: solarized-light nace en 4.13 y su tinte es casi invisible),
  ANSI >= 3 si ya lo tenía; los < 3 de origen y los de "papel de fondo" (black en oscuros,
  white/brightWhite en claros; brightWhite de github-light está a 3.04) pierden como mucho un 10%.
  Niveles: 14% oscuros, 8% claros.
- Cabecera sólida: `solidHeader()` elige tinta blanca o `#101318`; con HOST_COLORS el peor es Pink
  a 4.51:1. Pestaña: `color-mix` 14% (inactiva, 20% hover) sobre `--bg-secondary`, 30% sobre
  `--bg-card-hover` (activa); texto-secundario en claro queda en 4.65:1: no bajes la tinta más.
