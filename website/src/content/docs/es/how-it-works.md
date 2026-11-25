---
title: Cómo funciona
description: Tú y tu IA editan el mismo proyecto. Qué es un proyecto, quién hace qué y por qué nunca se pierde nada.
section: concepts
order: 1
---

Frameshell se basa en una idea: **tú y tu IA editan el mismo proyecto al mismo tiempo**. La IA hace el trabajo pesado a partir de tus palabras; tú ves cada cambio en vivo y corriges a mano lo que no te gusta. Cuando cambias algo, la IA lo lee y sigue desde tu versión.

## Quién hace qué

| Tú | Tu IA |
|---|---|
| Dices lo que quieres, con tus palabras | Planea la edición y pregunta cuando algo no está claro |
| Miras la vista previa y la línea de tiempo | Corta, coloca clips, escribe subtítulos, hace títulos y animaciones |
| Arrastras, recortas, divides, recuperas palabras | Lee tus cambios y sigue desde ellos |
| Decides todo lo que cuesta dinero o descarga algo | Ofrece opciones y pregunta antes de instalar, descargar o gastar |

Frameshell no trae su propia IA ni le manda nada a una. Le da a tu IA las herramientas que le faltan: una línea de tiempo que puede editar, una vista previa en vivo, fotogramas que puede mirar y una exportación rápida.

## Un proyecto es una carpeta

Cada proyecto es una carpeta normal en tu computadora. No hay nada escondido en una base de datos:

| En la carpeta | Qué es |
|---|---|
| `frameshell.json` | Los ajustes del proyecto: tamaño, cuadros por segundo, formatos como 9:16 |
| `assets/` | Tus grabaciones, música e imágenes, intactas |
| `timelines/` | Cada edición como un archivo JSON. `main.json` es la principal; un short o una versión corta es otra línea de tiempo del mismo material, sin copiar el video |
| `transcripts/` | Cada palabra dicha con su tiempo |
| `scripts/` | Guiones y planes, en Markdown |
| `exports/` | Los videos terminados |

Como son archivos de texto, puedes respaldarlos, ponerlos en Git o abrir una línea de tiempo en cualquier editor de texto. Un cambio hecho en un archivo aparece en la app al instante.

## Tu material nunca se toca

Los cortes, recortes y efectos son instrucciones en la línea de tiempo, no cambios en tus archivos. Borrar un clip de la línea de tiempo nunca borra la grabación, y siempre puedes recuperar una parte cortada.

## Dos tipos de proyecto

- **Proyectos de video**: tienen línea de tiempo con material, audio, subtítulos, títulos y clips generados.
- **Proyectos de imagen**: una imagen fija hecha de capas, para miniaturas, pósters y portadas. Mira [Miniaturas e imágenes](../images/).

## Dónde corre la IA

En una app de IA de tu computadora (Claude Desktop, la app de escritorio de ChatGPT) conectada a Frameshell, o como agente de programación dentro de la terminal de Frameshell. Las dos llegan al mismo proyecto con las mismas herramientas. Mira [Conecta tu IA](../connect-your-ai/).
