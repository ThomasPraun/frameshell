---
title: CLI y MCP
description: Para desarrolladores. El comando frameshell, el servidor MCP y dónde está la referencia completa.
section: reference
order: 2
---

Todo lo que hacen la app y tu IA pasa por un mismo proceso de fondo. Puedes llegar a él de dos formas: la línea de comandos `frameshell` y el servidor MCP. Las dos aceptan los mismos argumentos y quedan en los mismos Cambios.

## El comando `frameshell`

Está listo en la terminal de Frameshell. Para usarlo desde cualquier otra terminal, elige **Archivo > Instalar el comando 'frameshell' en el PATH**. En Linux, el `.deb` lo instala solo.

Algunos para empezar:

```sh
frameshell init                              # convertir esta carpeta en un proyecto
frameshell import assets/charla.mp4          # agregar material
frameshell transcribe assets/charla.mp4      # palabras con sus tiempos
frameshell timeline show --json              # la edición, como datos
frameshell cut --from 12.4 --to 15.1         # quitar un tramo y cerrar el hueco
frameshell render --preset youtube-1080p     # exportar
frameshell history                           # cada paso, con quién lo hizo
frameshell --help                            # todos los comandos y opciones
```

Los tiempos pueden ser segundos, nombres de marcadores (`--at hook+0.5`), pulsos y compases (`--at bar:8`) o palabras (`--from word:bueno --to word:bueno#2`).

## El servidor MCP

`frameshell mcp` ofrece cada operación como una herramienta MCP, además de fotogramas como imágenes y el estado de la app (cabezal, selección). Claude Desktop y la app de escritorio de ChatGPT lo usan a través de [Conecta tu IA](../connect-your-ai/). Otros:

```sh
frameshell setup claude-code    # o codex, gemini
claude mcp add frameshell -- frameshell mcp
```

## Referencia completa (en inglés)

- [Todos los comandos del CLI](https://github.com/ThomasPraun/frameshell/blob/main/skills/frameshell/reference/cli.md)
- [Servidor MCP](https://github.com/ThomasPraun/frameshell/blob/main/docs/mcp.md)
- [El skill del agente](https://github.com/ThomasPraun/frameshell/tree/main/skills/frameshell): lo que lee tu IA para aprender Frameshell
- [Archivos del proyecto](https://github.com/ThomasPraun/frameshell/blob/main/skills/frameshell/reference/project-model.md): `frameshell.json`, líneas de tiempo, transcripciones
- [Especificación](https://github.com/ThomasPraun/frameshell/blob/main/docs/SPEC.md): arquitectura y decisiones
