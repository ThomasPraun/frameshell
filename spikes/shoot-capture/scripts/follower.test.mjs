import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
import { createFollower, advance, tokenizeScript, normalize } from './follower.mjs';

const words = tokenizeScript(readFileSync(path.join(ROOT, 'media/speech/script.md'), 'utf8'));
const run = (hyps, st = createFollower(words)) => { for (const h of hyps) st = advance(st, h.split(' ')).state; return st; };

test('normalizes accents, case, digits', () => {
  assert.deepEqual(normalize('¡Vídeo, 30 SEGUNDOS!'), ['video', 'treinta', 'segundos']);
});
test('follows in order', () => {
  const st = run(['hola a todos', 'bienvenidos a este video']);
  assert.equal(words[st.idx].norm, 'video');
});
test('a hallucination loop does not move the position', () => {
  const st0 = run(['hola a todos bienvenidos']);
  const st = run(['la fecha de la fecha de la fecha de la fecha'], st0);
  assert.equal(st.idx, st0.idx);
});
test('unrelated speech does not move the position', () => {
  const st0 = run(['hola a todos bienvenidos']);
  assert.equal(run(['mañana compramos pan y leche'], st0).idx, st0.idx);
});
test('one lone common word far ahead does not jump', () => {
  const st0 = run(['hola a todos bienvenidos']);
  assert.equal(run(['de'], st0).idx, st0.idx);
});
test('skips a whole sentence after 3+ matching words', () => {
  const st0 = run(['hola a todos bienvenidos a este video sobre como grabar un buen rodaje']);
  const st = run(['el primero es colocar la ventana'], st0);
  assert.ok(words[st.idx].sentence >= 2, 'jumped past sentence 1');
});
test('restart of a sentence moves back only with 3+ words', () => {
  const st0 = run(['hola a todos bienvenidos a este video sobre como grabar']);
  const back = run(['hola a todos bienvenidos'], st0);
  assert.ok(back.idx < st0.idx);
  assert.equal(run(['hola a'], st0).idx, st0.idx);
});
test('tolerates a misrecognized word and an extra word', () => {
  const st = run(['hola a todos bueno bienvenidos a este vídeo sobre cobrada']);
  assert.ok(words[st.idx].norm === 'sobre' || words[st.idx].norm === 'como');
});
