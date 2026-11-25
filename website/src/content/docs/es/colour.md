---
title: Color y look de cine
description: Corrige exposición y balance de blancos, aplica un look incluido o tu propia LUT, y termina con grano, viñeta y bandas de cine.
section: guides
order: 10
---

## Qué pedir

- "Corrige el color de la entrevista: está muy azul y un poco oscura."
- "Muéstrame el clip con cada look incluido, uno al lado del otro."
- "Dale un look cálido de cine."
- "Usa esta LUT en todos los clips de la cámara."
- "Agrega un poco de grano y una viñeta suave."
- "Bandas de cine, 2.39."

Tu IA mide primero los niveles del clip y sugiere una corrección con un motivo para cada número. Nunca la aplica a ciegas: compara fotogramas y después la aplica.

## Correcciones

Cinco números por clip: **exposición** (en pasos de luz), **temperatura** (más frío o más cálido), **tinte** (más verde o más magenta), **contraste** y **saturación**. Encima, una **LUT** `.cube` del proyecto con una mezcla de nada a todo. El material grabado en un perfil LOG se detecta, con un aviso.

## Looks incluidos

`warm`, `cool`, `filmic`, `punchy`, `faded` y `mono`. Un look ajusta los cinco números de una vez; después los afinas.

## Acabado de cine

- **Grano**, igual en un fotograma dado en cada exportación.
- **Viñeta**: esquinas más oscuras.
- **Bandas negras**: para una forma de cine como 2.39 o 1.85. Un formato (por ejemplo 9:16) puede tener las suyas.

## En la app

Selecciona un clip y usa la sección **Color** del inspector: los cinco controles, la lista de looks, la LUT y su mezcla, y **Restablecer**. La sección **Acabado** tiene grano y viñeta, y el menú **Bandas negras** está junto al selector de formato sobre la vista previa. La vista previa muestra el color en vivo; una computadora sin WebGL2 muestra los clips sin él y lo avisa, pero la exportación lo aplica igual.
