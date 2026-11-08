/**
 * 广告给模型的工具 schema 必须结构良好（Lead 修复 TodoWrite 后加的守卫）。
 *
 * 背景：静态抽取曾把 z.array 之外的东西写成 {type:"unknown"}、把 .min(1,"msg")
 * 的**参数数组**塞进 minimum、并在 x-unresolved/x-raw 里留下未解析引用。
 * 而 Lead 早先的合并逻辑是「只填补 null、不纠正已有值」，于是这些坏形状
 * 一路广告给了模型 —— 实测 TodoWrite 的 todos 被写成 object（应为 array）。
 *
 * 这个测试不看某个具体工具，而是扫**全部**广告 schema 的结构合法性，
 * 让同类问题不可能再悄悄溜过去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSchemas } from '../src/tools/index.js';

const NUMERIC_BOUNDS = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'exclusiveMinimum', 'exclusiveMaximum'];

function walk(node, path, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'unknown') out.push(path + ': type 是 "unknown"（未解析）');
  if ('x-unresolved' in node || 'x-raw' in node) out.push(path + ': 残留未解析标记');
  for (const k of NUMERIC_BOUNDS) {
    if (k in node && typeof node[k] !== 'number') {
      out.push(path + '.' + k + ' 不是数字：' + JSON.stringify(String(node[k]).slice(0, 50)));
    }
  }
  if (node.type === 'array' && !node.items) out.push(path + ': array 缺 items');
  if (node.type === 'object' && node.properties) {
    for (const [k, v] of Object.entries(node.properties)) walk(v, path + '.' + k, out);
  }
  if (node.items) walk(node.items, path + '[]', out);
}

test('every advertised tool schema is structurally sound', () => {
  const bad = [];
  for (const s of toolSchemas()) {
    const issues = [];
    walk(s.function.parameters, s.function.name, issues);
    if (issues.length) bad.push(s.function.name + ' -> ' + issues.join('; '));
  }
  assert.deepEqual(bad, [], 'malformed schemas would mislead the model:\n' + bad.join('\n'));
});

test('TodoWrite tells the model the truth about todos and status', () => {
  const tw = toolSchemas().find((s) => s.function.name === 'TodoWrite');
  assert.ok(tw, 'TodoWrite must be advertised');
  const todos = tw.function.parameters.properties.todos;
  assert.equal(todos.type, 'array', 'todos is a list; advertising it as object made the model send the wrong shape');
  assert.ok(todos.items, 'an array must describe its items');
  const status = todos.items.properties.status;
  assert.equal(status.type, 'string');
  assert.ok(Array.isArray(status.enum), 'status must carry its allowed values');
  assert.ok(status.enum.includes('pending') && status.enum.includes('completed'));
  assert.deepEqual(todos.items.required, ['content', 'status', 'activeForm']);
});

test('the advertised schema matches what the tool itself validates against', () => {
  // 两者一旦分叉，模型会按广告写、工具按自己的 schema 拒 —— 这类 bug 极难排查。
  const schemas = toolSchemas();
  for (const name of ['TodoWrite', 'Read', 'Grep', 'Edit', 'Bash']) {
    const advertised = schemas.find((s) => s.function.name === name);
    assert.ok(advertised, name + ' must be advertised');
    assert.equal(advertised.function.parameters.type, 'object');
    assert.ok(advertised.function.parameters.properties, name + ' must describe its parameters');
  }
});
