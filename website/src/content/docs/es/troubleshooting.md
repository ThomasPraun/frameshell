---
title: Problemas comunes
description: La IA no ve Frameshell, Windows avisa al primer inicio, no se encuentra un comando, y qué mandar en un reporte de error.
section: help
order: 2
---

## Claude Desktop o ChatGPT no ven Frameshell

1. Abre **Conecta tu IA** y fíjate que la tarjeta de la app diga que está conectada. Si dice que Frameshell está configurado con otro comando, haz clic en **Conectar** otra vez.
2. Cierra la app de IA por completo (no solo su ventana) y vuelve a abrirla.
3. Deja tu proyecto abierto en Frameshell: una app de IA conectada así trabaja sobre el proyecto de la última ventana de Frameshell que usaste.

Si la tarjeta dice que el archivo de ajustes de la app no es válido, arréglalo o quítalo primero. Si dice que no pudo cambiar los ajustes, te da el motivo.

## Windows avisa al primer inicio

Frameshell todavía no está firmado para Windows, así que la primera vez SmartScreen muestra una ventana azul. Haz clic en **Más información** y luego en **Ejecutar de todas formas**. Pregunta una sola vez.

## "frameshell: command not found"

Fuera de la terminal de Frameshell, elige **Archivo > Instalar el comando 'frameshell' en el PATH** y abre una terminal nueva.

## El agente de la terminal no conoce Frameshell

Ábrelo desde la terminal de Frameshell, en la carpeta del proyecto. O pídele que lea `.claude/skills/frameshell/SKILL.md`.

## La transcripción tarda

La primera vez descarga el motor y el modelo, una sola vez. Después corre en tu computadora, así que su velocidad depende de la máquina: en una laptop sin una placa de video rápida, una grabación larga puede tardar varios minutos.

## La vista previa se ve distinta de la exportación

Un clip generado (título, animación) muestra una vista previa en vivo hasta que su render está listo; la exportación siempre usa el render. Una computadora sin WebGL2 no puede mostrar el color en la vista previa, y la app lo avisa; la exportación lo aplica igual.

## Cualquier otra cosa

Ejecuta `frameshell doctor` en la terminal del proyecto, o elige **Ayuda > Copiar diagnóstico**, y pégalo en un reporte de error: **Ayuda > Informar un problema…** abre uno en GitHub.
