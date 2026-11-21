---
title: Instalar Frameshell
description: Descarga la app de escritorio para macOS, Windows o Linux, y qué descarga después por su cuenta.
section: start
order: 1
---

Frameshell es una app de escritorio. Es gratis y de código abierto, y no trae su propia IA: usas la app de IA que ya tienes.

## Descarga

Baja el archivo para tu computadora desde la [última versión](https://github.com/ThomasPraun/frameshell/releases/latest):

| Computadora | Archivo | Notas |
|---|---|---|
| Mac con Apple silicon o Intel | `.dmg` | Firmada y notarizada. Ábrela y arrastra Frameshell a Aplicaciones. |
| Windows x64 | `.exe` | Por ahora sin firma: la primera vez, SmartScreen avisa. Haz clic en **Más información** y luego en **Ejecutar de todas formas**. |
| Linux x64 | `.deb` o `.AppImage` | Beta: probada en CI, todavía no a mano. |

Las versiones instaladas buscan actualizaciones solas. **Ayuda > Buscar actualizaciones…** lo hace en el momento.

## Qué descarga después

El instalador es chico a propósito. Las herramientas que Frameshell necesita se descargan la primera vez que las usas, y antes de algo grande te dice el tamaño:

- **ffmpeg**, para las vistas previas, el audio y la exportación.
- **El motor de transcripción y su modelo** (unos 600 MB), la primera vez que transcribes. Puedes saltarlo.
- **Chrome sin ventana**, la primera vez que se renderiza un clip generado (títulos, animaciones).

La vista **Plugins** de la barra lateral lista todo lo que Frameshell descargó en esta computadora, con su tamaño y un botón **Quitar**.

## Siguiente paso

[Conecta tu IA](../connect-your-ai/) y haz [tu primer video](../first-video/).
