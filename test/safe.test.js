import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { safeName, safeJoin } from '../src/safe.js';

test('safeName strips path characters and keeps readable text', () => {
  assert.equal(safeName('../../etc/passwd'), 'etc passwd');
  assert.equal(safeName('a<b>c:d"e|f?g*h'), 'a b c d e f g h');
  assert.equal(safeName('  Dragon   Knight  '), 'Dragon Knight');
});

test('safeName avoids empty names, reserved Windows names and long names', () => {
  assert.equal(safeName(''), 'model');
  assert.equal(safeName('...'), 'model');
  assert.equal(safeName('CON'), 'model');
  assert.equal(safeName('nul', 'x'), 'x');
  assert.equal(safeName('a'.repeat(200)).length, 80);
});

test('safeJoin stays inside the root', () => {
  const root = path.resolve('some-root');
  assert.equal(safeJoin(root, 'a', 'b.glb'), path.join(root, 'a', 'b.glb'));
  assert.equal(safeJoin(root, '..'), null);
  assert.equal(safeJoin(root, '..', 'x'), null);
  assert.equal(safeJoin(root, 'a/../../x'), null);
  assert.equal(safeJoin(root, 'a\\..\\x'), null);
  assert.equal(safeJoin(root, ''), null);
  assert.equal(safeJoin(root, 'a\0b'), null);
});
