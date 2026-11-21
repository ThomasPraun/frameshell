---
title: Editar a mano
description: La línea de tiempo, la transcripción, el inspector y la vista previa, con cada gesto y atajo.
section: concepts
order: 2
---

La IA hace la primera pasada; tú la corriges. Todo lo que haces a mano se guarda al instante y queda en [Cambios](../history-and-review/), así la IA lo ve y tú puedes deshacerlo.

## La línea de tiempo

Los clips están en pistas: video, audio, subtítulos. Un corte quita el tramo y cierra el hueco.

| Para | Cómo |
|---|---|
| Seleccionar un clip | Clic. <kbd>Shift</kbd> o <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+clic agrega o quita uno; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>A</kbd> selecciona todo |
| Mover | Arrastra los clips seleccionados |
| Recortar | Arrastra un borde. Mantén <kbd>Shift</kbd> al presionarlo (o presiona <kbd>R</kbd>) para recortar en cadena: los clips siguientes acompañan |
| Dividir | <kbd>S</kbd> divide en el cabezal |
| Recortar hasta el cabezal | <kbd>[</kbd> y <kbd>]</kbd> |
| Mover un cuadro | <kbd>,</kbd> y <kbd>.</kbd> |
| Borrar | <kbd>Supr</kbd> deja un hueco; <kbd>Shift</kbd>+<kbd>Supr</kbd> lo cierra |
| Seleccionar un tramo | Arrastra sobre un espacio vacío |
| Mover el cabezal | Clic en la regla, o las flechas |
| Activar o desactivar el imán | <kbd>N</kbd> |
| Zoom | <kbd>+</kbd> y <kbd>-</kbd>; <kbd>0</kbd> muestra toda la línea de tiempo |
| Deshacer / rehacer | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd>; <kbd>Ctrl</kbd>+<kbd>Y</kbd> o <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |

Para poner material en la línea de tiempo sin la IA, arrastra un video o un sonido desde **Archivos** (en la barra lateral) hasta una pista, o haz clic derecho sobre él en `assets/` y elige **Agregar a la línea de tiempo**. Haz clic derecho en un clip, en el encabezado de una pista o en la regla para más opciones: marcadores, opciones de pista, "Poner detrás de la persona".

## La transcripción

Haz clic en **Transcripción** en las pestañas del editor (o abre un archivo de `transcripts/`). Lista cada palabra de la línea de tiempo, en orden.

- Una palabra cortada aparece **tachada**. Haz clic para recuperarla; **↺** recupera todo un pasaje cortado.
- Haz clic o arrastra sobre palabras para seleccionarlas; el cabezal salta ahí.
- Doble clic en una palabra (o <kbd>F2</kbd>) para corregir lo que la transcripción entendió mal.
- Para cortar palabras, selecciónalas y usa **Hablar de esto** ("corta esto"), o corta el mismo tramo en la línea de tiempo.

## El inspector

Selecciona un clip y el inspector muestra lo que puedes cambiar: posición y tamaño, opacidad, volumen y silencio, limpieza de voz, color, acabado (grano, viñeta, bandas negras), transiciones y valores animados. Los subtítulos tienen su propio inspector para el estilo. En la vista previa puedes arrastrar los controles de la capa seleccionada para moverla o escalarla.

## Hablar de esto

Selecciona cualquier cosa (clips, palabras, un tramo, un archivo, un punto de la vista previa) y presiona <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>L</kbd>, o haz clic derecho y elige **Hablar de esto**. Tu IA recibe una referencia exacta, así "sube el volumen de esto" o "corta esta parte" significa lo que seleccionaste.

## Paneles en su propia ventana

La mayoría de los paneles (línea de tiempo, transcripción, Cambios, Personas, Ángulos) se pueden abrir en su propia ventana, para una segunda pantalla. Vuelven a su lugar desde el mismo botón.
