---
title: Conecta tu IA
description: Vincula Claude Desktop, la app de escritorio de ChatGPT o un agente de programación con Frameshell para que edite tus proyectos.
section: start
order: 2
---

Frameshell hace el trabajo de video; una app de IA que ya usas hace el razonamiento. La conectas una vez y puede abrir, editar y exportar cualquier proyecto que tengas abierto en Frameshell.

## Claude Desktop o la app de escritorio de ChatGPT

1. Instala [Claude Desktop](https://claude.ai/download) o la app de escritorio de ChatGPT y ábrela una vez. Su tarjeta en Frameshell ofrece **Conectar** recién cuando la app creó su carpeta de ajustes.
2. En Frameshell, haz clic en **Conecta tu IA**: está en la barra de título de la ventana del proyecto y en la pantalla de bienvenida.
3. Haz clic en **Conectar** en la tarjeta de la app.
4. Cierra la app de IA por completo y vuelve a abrirla.

Una vez conectada, **Abrir Claude Desktop** o **Abrir ChatGPT** en la tarjeta abre la app y copia una frase para empezar que puedes pegar como primer mensaje. **Desconectar** lo deshace; Frameshell guarda una copia de los ajustes de la app antes de cambiarlos.

> ChatGPT en la web no funciona: necesita un servidor público. En Linux no hay botón Conectar para Claude Desktop; usa una herramienta para desarrolladores de las de abajo.

## Agentes de programación en la terminal

Si ya usas Claude Code, Codex, Gemini CLI u OpenCode, puedes usarlo dentro de Frameshell. Abre la terminal (**Ver > Terminal**, o <kbd>Ctrl</kbd>+<kbd>\\</kbd>, <kbd>Cmd</kbd>+<kbd>\\</kbd> en Mac): su guía lista los agentes que encontró en tu computadora, cada uno con un botón **Abrir**, y el comando para instalar los demás.

El grupo "Para desarrolladores" de **Conecta tu IA** también conecta Claude Code, Codex CLI y Gemini CLI, y tiene un fragmento para pegar en Cursor, VS Code o cualquier otro cliente MCP.

La [página de agentes](/es/agents/) tiene cada agente paso a paso, con los comandos para cada sistema.

## Comprueba que funciona

Abre un proyecto en Frameshell y pregúntale a tu IA: "¿Qué está abierto en Frameshell ahora?". Debería nombrar tu proyecto y su línea de tiempo. Si no, cierra y vuelve a abrir la app de IA, y mira [Problemas comunes](../troubleshooting/).
