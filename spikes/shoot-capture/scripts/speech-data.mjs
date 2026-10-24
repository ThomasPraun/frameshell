// Script (what the presenter should say) and the two spoken variants.
export const SCRIPT = [
  'Hola a todos, bienvenidos a este vídeo sobre cómo grabar un buen rodaje.',
  'Hoy vamos a ver tres consejos muy sencillos para mejorar la luz.',
  'El primero es colocar la ventana a un lado de la cámara.',
  'El segundo consejo es evitar las luces mixtas de distintos colores.',
  'Por último, graba siempre treinta segundos de silencio en la sala.',
  'Con esto tendrás un material limpio y listo para editar.',
  'Gracias por ver el vídeo, nos vemos en el siguiente.',
];
// Variant B: sentence 3 skipped, extra words in 2, one misread word in 4, a restart in 5.
export const SPOKEN_B = [
  SCRIPT[0],
  'Hoy vamos a ver, bueno, la verdad es que son tres consejos muy sencillos para mejorar la luz.',
  SCRIPT[3].replace('mixtas', 'mezcladas'),
  'Por último, graba siempre',
  SCRIPT[4],
  SCRIPT[5],
  SCRIPT[6],
];
export const VARIANTS = { a: SCRIPT, b: SPOKEN_B };
