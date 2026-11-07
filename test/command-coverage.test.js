import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCoverage } from '../scripts/command-coverage.mjs';

test('coverage deduplicates the entire denominator, not only excluded names', () => {
  const r = commandCoverage(['read', 'read', 'login', 'login', 'edit'], new Set(['login']), new Set(['read']), new Set(['read','edit']));
  assert.equal(r.builtinRegistrations, 5);
  assert.equal(r.builtinCommands, 3);
  assert.equal(r.localCommands + r.excluded.length, r.builtinCommands);
  assert.deepEqual(r.excluded, ['login']);
  assert.equal(r.tuiPct, 50); assert.equal(r.guiPct, 100);
  assert.equal(r.tuiAllPct, 33); assert.equal(r.guiAllPct, 67);
  assert.deepEqual(r.tuiMissing, ['edit']);
  assert.deepEqual(r.duplicateRegistrations, [{name:'read',count:2},{name:'login',count:2}]);
});
test('empty local denominator is unknown, not a false 100%', () => {
  const r = commandCoverage(['login'], new Set(['login']), new Set(), new Set());
  assert.equal(r.tuiPct, null); assert.equal(r.guiPct, null);
  assert.equal(commandCoverage([], new Set(), new Set(), new Set()).tuiAllPct, null);
});
test('invalid registration data fails explicitly', () => {
  for (const x of [null, [''], [null], [1]]) assert.throws(() => commandCoverage(x, new Set(), new Set(), new Set()), TypeError);
});
