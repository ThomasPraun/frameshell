---
title: Preguntas frecuentes
description: Costo, privacidad, qué IA usar, trabajar sin internet, otros editores y qué no es Frameshell.
section: help
order: 1
---

## ¿Qué es Frameshell?

Un editor de video de escritorio donde una IA hace la edición a partir de lo que le pides y tú la ves y la corriges en una línea de tiempo de verdad. Piénsalo como un IDE, como VS Code o Cursor, cuyo resultado es un video.

## ¿Es gratis?

Sí. Frameshell es de código abierto con licencia Apache 2.0 y no cuesta nada. Lo que puedes pagar está fuera de él: el plan de tu app de IA, y plugins opcionales en la nube como la voz en off de OpenAI, cobrados a tu propia cuenta. Frameshell siempre te dice el costo antes de gastar algo.

## ¿Qué IA necesito?

Una que ya uses. Las más fáciles son **Claude Desktop** y la **app de escritorio de ChatGPT**, que se conectan con un clic. Si programas, puedes usar **Claude Code**, **Codex**, **Gemini CLI**, **OpenCode** o cualquier cliente MCP. Mira [Conecta tu IA](../connect-your-ai/).

## ¿Frameshell trae una IA?

No. No le manda nada a una IA por su cuenta. Tu app de IA lee el proyecto con las herramientas de Frameshell, igual que tú lo ves en la app.

## ¿Puedo usarlo sin IA?

Sí, como un editor común: arrastras material a la línea de tiempo, cortas, recortas, agregas transiciones, color y subtítulos, y exportas. Pero la gracia es que la IA haga las partes lentas.

## ¿Dónde están mis archivos? ¿Se sube mi material?

Tu proyecto es una carpeta normal en tu computadora, y tu material se queda ahí. La transcripción corre en tu computadora por defecto. Solo un plugin opcional en la nube (transcripción o voz en off de OpenAI) manda algo afuera, y pregunta antes de cada subida. Tu app de IA ve lo que lee a través de Frameshell: fotogramas, la transcripción, la línea de tiempo.

## ¿Cambia mis grabaciones originales?

Nunca. Los cortes y efectos son instrucciones en la línea de tiempo. Mira [Cómo funciona](../how-it-works/).

## ¿Funciona sin internet?

Frameshell sí, una vez descargadas sus herramientas: editar, la vista previa, la transcripción local y la exportación no necesitan internet. Tu app de IA necesita su propia conexión.

## ¿Qué idiomas entiende la transcripción?

whisper.cpp entiende muchos idiomas, entre ellos español e inglés. También puedes registrar tu propio modelo de Whisper, por ejemplo uno entrenado para tu idioma.

## ¿En qué computadoras funciona?

macOS (Apple silicon e Intel), Windows x64 y Linux x64 (beta). La transcripción y el 3D van más rápido en una máquina reciente; en una lenta, pide exportaciones borrador mientras iteras.

## ¿Puedo terminar en Premiere, DaVinci Resolve o Final Cut?

Sí. **Archivo > Exportar XML de Premiere…** se abre en Premiere Pro; **Archivo > Exportar OpenTimelineIO…** se abre en Resolve y en otros editores que leen OTIO. Los efectos que Frameshell no puede pasar se listan al exportar. Mira [Exportar](../export/).

## ¿En qué formatos exporta?

MP4 (H.264 + AAC) para YouTube a 1080p o 1440p, vertical 1080x1920 para Shorts, Reels y TikTok, un GIF en bucle, y PNG, JPEG o WebP para imágenes. Una misma edición puede salir en varios formatos a la vez, como 16:9 y 9:16.

## ¿La IA puede romper mi proyecto?

Cada cambio es un paso en **Cambios** que puedes revertir, y el modo revisión te deja aprobar cada cambio antes de que se aplique. Mira [Cambios, deshacer y revisión](../history-and-review/).

## ¿Puedo editar los archivos del proyecto yo mismo?

Sí. Las líneas de tiempo, los guiones y los ajustes son archivos de texto. Edítalos en cualquier editor o en las pestañas de editor de Frameshell; la app muestra el cambio al instante y Cambios lo registra.

## ¿Está listo para trabajo profesional?

Está en alfa. Funciona, se usa todos los días y tiene asperezas. Respalda tus originales y [avísanos](https://github.com/ThomasPraun/frameshell/issues) cuando algo falle.

## ¿Cómo informo un error o pido una función?

**Ayuda > Informar un problema…** abre un reporte de error en GitHub. Pega ahí los datos de **Ayuda > Copiar diagnóstico**: describen tu equipo y no contienen archivos ni secretos.
