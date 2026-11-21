---
title: Plugins
description: Extras opcionales para transcripción, títulos animados, escenas en React, 3D y voces en la nube. Qué necesita, cuesta y descarga cada uno.
section: reference
order: 1
---

Frameshell funciona sin plugins. Los plugins agregan nuevos tipos de clip o nuevos servicios, por proyecto. Abre la vista **Plugins** en la barra lateral para ver cada uno con lo que necesita, lo que cuesta y lo que descarga la primera vez, y **Instalarlo** o **Quitarlo** con un clic. Tu IA puede sugerir uno, pero nada se instala sin tu sí.

## Plugins oficiales

| Plugin | Qué agrega | Costo |
|---|---|---|
| **Transcripción con whisper.cpp** | Convierte la voz en palabras con sus tiempos, en tu computadora. Hace falta para subtítulos, cortar pausas y editar por palabras. La primera vez descarga el motor y un modelo (unos 600 MB) | Gratis, funciona sin internet |
| **Transcripción con OpenAI** | Lo mismo, con el servicio en la nube de OpenAI | De pago, a tu propia cuenta de OpenAI; pregunta antes de cada subida |
| **Voz en off con OpenAI** | Narración generada desde texto con las voces de OpenAI | De pago, a tu propia cuenta de OpenAI; muestra el estimado antes |
| **HyperFrames** | Títulos animados, zócalos, overlays y gráficos escritos en HTML, con transparencia | Gratis |
| **Remotion** | Escenas y overlays animados hechos con React, incluso con componentes de tu propia app | Gratis; para empresas rige la [licencia de Remotion](https://www.remotion.dev/license) |
| **Blender** | Escenas 3D desde archivos `.blend`, con transparencia | Gratis; necesita tu propio Blender (4.5 LTS o 5.x) |

La primera instalación de un plugin lo descarga con npm y puede tardar uno o dos minutos.

## Confianza

Los plugins tienen acceso total a tu computadora. Cuando abres un proyecto que hizo otra persona y declara plugins, la vista Plugins muestra un aviso: **Confiar** los activa, **No confiar** los deja apagados. Confía solo en un proyecto de un origen en el que confías. Los plugins que instalas tú ya quedan con confianza.

## Descargas en esta computadora

La misma vista lista lo que Frameshell descargó (ffmpeg, el motor de transcripción y sus modelos, Chrome sin ventana) con su tamaño y un botón **Quitar**. Lo que quites se vuelve a descargar cuando haga falta.

## Desde una terminal

```sh
frameshell plugin catalog                          # qué hay, qué necesita y cuánto cuesta
frameshell plugin install @frameshell/whisper-cpp  # instalar en este proyecto
frameshell plugin list                             # instalados, con lo que agrega cada uno
frameshell doctor                                  # descargas en esta computadora
```
