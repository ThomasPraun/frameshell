---
title: Títulos y animaciones
description: Zócalos, títulos animados, tarjetas, diagramas y escenas 3D como clips en la línea de tiempo, escritos como código por tu IA y editables señalándolos.
section: guides
order: 8
---

Los títulos y gráficos en Frameshell son **clips generados**: pequeñas composiciones que tu IA escribe en HTML, React o Blender, renderizadas con transparencia sobre tu material. Están en la línea de tiempo como cualquier clip.

## Motores

| Plugin | Sirve para |
|---|---|
| **HyperFrames** (HTML y CSS) | Títulos, zócalos, tarjetas, gráficos de datos, un dibujo con tiza sobre el material |
| **Remotion** (React) | Demos de interfaz y escenas hechas con componentes de tu propia app |
| **Blender** (3D) | Un producto u objeto principal en 3D; necesita tu propio Blender |

Instálalos desde la vista **Plugins**. Tu IA te sugiere uno cuando pides algo que lo necesita.

## Qué pedir

- "Un zócalo con mi nombre y cargo cuando aparezco por primera vez."
- "Un título animado para la intro, con los colores de la marca."
- "Una tarjeta con los tres pasos cuando los enumero."
- "Haz el título más grande y súbelo."

## En la app

- Un clip generado **se reproduce en vivo** en la vista previa mientras se renderiza, con una etiqueta que lo indica. La exportación siempre usa el render terminado.
- Selecciónalo y el **inspector** muestra sus ajustes: posición, tamaño, opacidad, vidrio (desenfoca lo que tiene debajo), desenfoque de movimiento.
- Usa la herramienta **Elegir** de la vista previa (<kbd>I</kbd>) para hacer clic en una parte de un título. **Hablar de esto** le dice entonces a tu IA exactamente qué elemento quieres decir: "pon esta palabra en amarillo".
- Su archivo fuente se abre en una pestaña del editor, si quieres cambiar el código tú.

## Cuando el proyecto viene de otra persona

Los plugins tienen acceso total a tu computadora, así que un proyecto que declara plugins te pide **Confiar** en ellos primero. Hasta entonces sus clips generados no se renderizan.
