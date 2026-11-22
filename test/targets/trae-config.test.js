import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  traeModelEntry, mergeTraeModelMap, inspectTraeModelMap,
  syncTraeModels, readTraeModelMaps, MODEL_LIST_SUFFIX,
} from '../../src/service/config/trae-config.ts';
import { SOURCE_OWNERS } from '../../src/service/sync/sync.ts';

// 模拟 Trae 原生落盘的一份 model_list_map：预设模型不带我们的标记。
const PRESET = { name: 'Doubao-Seed-Code', display_name: 'Seed-Code', is_preset: true };
const USER_MANUAL = { name: 'custom_openai_compatible//sensenova-6.8-flash', display_name: 'sensenova-6.8-flash', is_preset: false, config_source: 3 };
const SN = { id: 'SN · sensenova-6.8-flash', upstream: 'sensenova-6.8-flash', name: '6.8 Flash', context: 327680, images: true, levels: ['low', 'high'] };
const SN2 = { id: 'SN · sensenova-6.8-flash-lite', upstream: 'sensenova-6.8-flash-lite', name: '6.8 Flash Lite', context: 200000, images: false };

test('traeModelEntry：字段形状照抄 Trae 原生落盘样本', () => {
  const entry = traeModelEntry(SN, 'https://token.sensenova.cn/v1', 'sk-test', {
    owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  });
  assert.equal(entry.name, 'custom_openai_compatible//sensenova-6.8-flash');
  assert.equal(entry.config_name, entry.name);
  assert.equal(entry.display_name, 'SN · sensenova-6.8-flash');
  assert.equal(entry.provider, 'custom_openai_compatible');
  assert.equal(entry.base_url, 'https://token.sensenova.cn/v1/chat/completions');
  assert.equal(entry.is_custom_base_url, true);
  assert.equal(entry.is_preset, false);
  assert.equal(entry.config_source, 3);
  assert.equal(entry.auth_type, 0);
  assert.equal(entry.ak, 'sk-test');
  assert.equal(entry.sk, '');
  assert.equal(entry.use_remote_service, false);
  assert.equal(entry.mobridgeOwner, SOURCE_OWNERS.sensenova);
  assert.equal(entry.context_window_size.default, 327680);
  assert.equal(entry.prompt_max_tokens, 327680);
  assert.equal(entry.thinking_enable, 1);
  assert.deepEqual(entry.reasoning_param.values, ['default', 'none', 'low', 'high']);
  assert.match(entry.custom_model_id, /^\d{10}$/);
  assert.equal('reasoning_param' in traeModelEntry(SN2, 'https://token.sensenova.cn/v1', 'k', { owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id }), false, '没有思考档位时不写 reasoning 字段');
});

test('mergeTraeModelMap：追加进每个模式数组，用户与预设条目原样保留', () => {
  const map = {
    builder: [PRESET],
    solo_agent: [PRESET, USER_MANUAL],
    solo_coder: [],
  };
  const { map: merged } = mergeTraeModelMap(map, [SN], 'https://token.sensenova.cn/v1', 'sk-test', {
    owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  });
  assert.equal(merged.builder.length, 2);
  // 用户手动加过同一条（name 相同）：同名冲突让位给用户，墨桥条目跳过不追加。
  assert.equal(merged.solo_agent.length, 2);
  assert.ok(merged.solo_coder.length === 1);
  const ours = merged.solo_coder[0];
  assert.equal(ours.name, 'custom_openai_compatible//sensenova-6.8-flash');
  assert.equal(ours.mobridgeOwner, SOURCE_OWNERS.sensenova);
});

test('mergeTraeModelMap：models 为空 = 只摘自己的条目（三路来源各自认领）', () => {
  const oursSN = { name: 'custom_openai_compatible//a', mobridgeOwner: SOURCE_OWNERS.sensenova };
  const oursOC = { name: 'custom_openai_compatible//b', mobridgeOwner: SOURCE_OWNERS.opencode };
  const map = { builder: [PRESET, oursSN, oursOC], chat: [oursSN] };
  const { map: merged } = mergeTraeModelMap(map, [], '', '', { owner: SOURCE_OWNERS.sensenova });
  assert.deepEqual(merged.builder, [PRESET, oursOC], '只摘日日新那一路的条目');
  assert.deepEqual(merged.chat, []);
  // 全三路一起摘：传任一 owner 只摘一路，这里模拟 OpenCode 线摘自己。
  const { map: merged2 } = mergeTraeModelMap(map, [], '', '', { owner: SOURCE_OWNERS.opencode });
  assert.deepEqual(merged2.builder, [PRESET, oursSN]);
});

test('inspectTraeModelMap：按来源分家，display_name 去重', () => {
  const map = {
    builder: [PRESET, { name: 'x', display_name: 'SN · a', mobridgeOwner: SOURCE_OWNERS.sensenova }],
    solo_agent: [PRESET, { name: 'x', display_name: 'SN · a', mobridgeOwner: SOURCE_OWNERS.sensenova }, { name: 'y', display_name: 'OC · b', mobridgeOwner: SOURCE_OWNERS.opencode }],
  };
  const info = inspectTraeModelMap(map);
  assert.equal(info.owned, 2, '同一模型出现在多个模式数组只算一次');
  assert.equal(info.sources.sensenova.count, 1);
  assert.equal(info.sources.opencode.count, 1);
});

// ── SQLite 全链路：用 sql.js 造一份真 state.vscdb 再走 syncTraeModels ──
// 本机可能正开着 Trae：测试写的是沙箱 DB，进程检测要放行。
process.env.MOBRIDGE_ALLOW_RUNNING_CLIENTS = '1';

async function makeStateFile(mapEntries) {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  for (const [key, value] of mapEntries) db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  const bytes = db.export();
  db.close();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-trae-'));
  const file = path.join(dir, 'state.vscdb');
  await fs.writeFile(file, Buffer.from(bytes));
  return file;
}

test('syncTraeModels：两个键都写入、可读回、可移除', async () => {
  const map = { builder: [PRESET], solo_agent: [PRESET] };
  const file = await makeStateFile([
    ['1963096238748249:AI.agent.model.model_list_map', map],
    ['1963096238748249_AI.agent.model.model_list_map', map],
  ]);
  const options = {
    owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  };
  const first = await syncTraeModels([SN, SN2], 'https://token.sensenova.cn/v1', 'sk-test', { file, ...options });
  assert.equal(first.changed, true);
  assert.equal(first.count, 2);
  assert.deepEqual(first.keys?.sort(), ['1963096238748249_AI.agent.model.model_list_map', '1963096238748249:AI.agent.model.model_list_map'].sort());
  const maps = await readTraeModelMaps(file);
  assert.equal(maps.length, 2);
  for (const { value } of maps) {
    assert.equal(value.builder.length, 3, '预设 + 两个墨桥条目');
    assert.equal(value.builder.filter(entry => entry.mobridgeOwner === SOURCE_OWNERS.sensenova).length, 2);
  }
  const again = await syncTraeModels([SN, SN2], 'https://token.sensenova.cn/v1', 'sk-test', { file, ...options });
  assert.equal(again.changed, false, '同内容不重复写');
  const removed = await syncTraeModels([], '', '', { file, ...options });
  assert.equal(removed.changed, true);
  const after = await readTraeModelMaps(file);
  for (const { value } of after) assert.equal(value.builder.length, 1, '只剩预设条目');
  const backups = (await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.bak'));
  assert.ok(backups.length >= 1, '写前留了 DB 备份');
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});

test('syncTraeModels：不是清单键的数据行不受影响', async () => {
  const file = await makeStateFile([
    ['workbench.explorer.views.state.hidden', 0],
    ['1963096238748249:AI.agent.model.model_list_map', { builder: [PRESET] }],
    ['content.trust.model.key', JSON.stringify({ uriTrustInfo: [] })],
  ]);
  const result = await syncTraeModels([SN], 'https://token.sensenova.cn/v1', 'k', {
    file, owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  });
  assert.equal(result.changed, true);
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(await fs.readFile(file));
  const rows = db.exec("SELECT value FROM ItemTable WHERE key = 'workbench.explorer.views.state.hidden'");
  assert.equal(String(rows[0].values[0][0]), '0', '非清单键原样保留');
  db.close();
  await fs.rm(path.dirname(file), { recursive: true, force: true });
});
