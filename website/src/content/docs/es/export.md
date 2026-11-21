---
title: Exportar y pasar a otro editor
description: Exporta para YouTube, Shorts, Reels y TikTok, borradores mientras revisas, bucles y GIFs, cómo comprobar el resultado y cómo pasar la línea de tiempo a Premiere o Resolve.
section: guides
order: 19
---

## Exportar

Pídele a tu IA: "Expórtalo para YouTube", "Exporta la versión vertical", "Exporta todos los formatos". El archivo queda en la carpeta `exports/` del proyecto.

| Preset | Para |
|---|---|
| YouTube 1080p, 1440p | Video horizontal, H.264 + AAC |
| Vertical 1080x1920 | Shorts, Reels, TikTok |
| GIF | Un bucle sin sonido, hasta 1200 px |

**Borrador o final.** Mientras revisas, pide borradores: una codificación rápida a 30 fps como mucho. El final es más lento y a calidad completa.

**Varios formatos** de una edición salen como un archivo cada uno.

**El primer fotograma** es la miniatura en la mayoría de las plataformas. Si está en negro, tu IA recibe un aviso y puede poner una portada ahí: un fotograma con una palabra grande.

## Bucles y GIFs

Títulos en bucle, banners y GIFs para un README vuelven a empezar desde el primer fotograma. Pide "un bucle sin cortes" y tu IA lo arma para que el último fotograma lleve al primero, y después revisa la unión.

## Comprueba antes de compartir

Antes de mostrarte un video, tu IA puede revisarlo: hojas de contacto de toda la película, cómo se ve en un teléfono, zonas seguras por plataforma, volumen, subtítulos demasiado cortos para leer, tramos largos sin movimiento. También puede transcribir de nuevo la exportación para asegurarse de que no se perdió ninguna palabra en un corte. Pide "revisa la exportación antes de mostrármela".

## Pasar a otro editor

- **Archivo > Exportar XML de Premiere…** para Premiere Pro (ahí, **Archivo > Importar**).
- **Archivo > Exportar OpenTimelineIO…** para DaVinci Resolve y otros editores que leen OTIO.

Pasan los cortes, los clips, los fundidos encadenados y el volumen de cada clip. Lo que no puede pasar (subtítulos, clips generados, corrección de color, transformaciones, efectos de audio) se lista al exportar; los clips generados quedan en su lugar como material sin conexión.
