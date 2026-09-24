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
