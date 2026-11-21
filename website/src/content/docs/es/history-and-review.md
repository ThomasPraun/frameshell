---
title: Cambios, deshacer y revisión
description: Cada cambio, tuyo o de la IA, es un paso que puedes ver y revertir. El modo revisión te deja aprobar las ediciones de la IA antes de que se apliquen.
section: concepts
order: 3
---

## Cambios

Abre **Cambios** en la barra lateral, junto a Archivos. Cada entrada es un paso, del más nuevo al más viejo, con quién lo hizo (**Tú**, **Terminal**, el nombre de la IA, **Archivo** para una edición directa de un archivo, **Plugin**), qué hizo y cuándo.

- **Selecciona una entrada** para ver sus cambios marcados en la línea de tiempo: `+` agregado, `−` quitado, `↔` movido, `~` cambiado.
- **Revertir** deshace ese paso, aunque después haya otros cambios.
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> deshace tu último cambio.

Pídele a tu IA "muéstrame qué cambiaste" y abre Cambios en su propio paso.

## Modo revisión

¿Quieres aprobar cada edición antes de que se aplique? Activa el modo revisión con el interruptor de **Cambios**, o en **Archivo > Revisar los cambios del agente antes de aplicarlos**.

Desde ese momento, los cambios de la IA esperan como una **propuesta**. Una barra en cada ventana la muestra con **Antes** y **Después** para que mires las dos versiones, y luego la **Aceptas** o la **Rechazas**. Mientras una propuesta espera, tus propias ediciones se aplican igual.

## No se pierde nada

- Tus grabaciones nunca cambian: los cortes son instrucciones en la línea de tiempo.
- Una palabra o parte cortada siempre puede volver, desde la transcripción o desde Cambios.
- Un archivo que borras del proyecto va a la papelera de tu computadora, después de que Frameshell te dice qué clips lo usan.
