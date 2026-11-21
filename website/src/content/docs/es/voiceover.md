---
title: Voz en off
description: Una narración generada desde un guion, una toma por línea, puesta sobre la imagen con subtítulos que coinciden. Cuánto cuesta y cómo arreglar una palabra que la voz dice mal.
section: guides
order: 13
---

Frameshell no tiene voz propia. Un plugin de voz dice las líneas: el oficial es **Voz en off con OpenAI**, que es de pago y se cobra a tu propia cuenta de OpenAI.

## Qué pedir

- "Escribe un guion de voz en off para este video, 45 segundos."
- "Genera la voz en off con una voz femenina tranquila."
- "Pon cada línea en su escena y agrega subtítulos."
- "Rehaz la segunda línea, más lento."

## El guion

Un guion de voz en off es un archivo en `scripts/`, una escena por título y una línea hablada por línea de texto. Las notas entre corchetes nunca se leen. Dos detalles hacen que suene bien:

- **Los nombres que la voz dice mal** se escriben dos veces: lo que se muestra en los subtítulos y cómo se dice, por ejemplo `{Frameshell|freim shel}`.
- **Los números** se escriben en palabras para la voz en español e inglés, y quedan en dígitos en los subtítulos.

Una voz lee unas 2,5 palabras por segundo, así que tu IA avisa cuando una escena tiene más palabras que su tiempo.

## Costo

Antes de generar algo de pago, Frameshell muestra un estimado y espera a que confirmes. Cada toma terminada se guarda en `assets/voiceover/`, así una línea nunca se paga dos veces; solo se vuelven a generar las líneas que cambias.

## En la app

La ventana de voz en off muestra cada línea mientras se dice y se comprueba. Cada toma se transcribe y se compara con el guion, así se lista una palabra salteada o mal leída. **Colocar voz en off…** pone las líneas en sus escenas o marcadores.
