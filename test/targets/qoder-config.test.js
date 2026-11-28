import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  providerKeyOf, qoderProvider, qoderModelEntry, mergeQoderProviders,
  inspectQoderProviders, syncQoderProviders, resolveQoderConfig,
} from '../../src/service/config/qoder-config.ts';
import { SOURCE_OWNERS } from '../../src/service/sync/sync.ts';

// 模型形状与日日新/AtomCode 写入器传进来的一致：id 是展示名、upstream 是上游真名。
const SN = { id: 'SN · sensenova-6.8-flash', upstream: 'sensenova-6.8-flash', name: '6.8 Flash', context: 327680, images: true, levels: ['low', 'high'] };
const SN2 = { id: 'SN · sensenova-6.8-flash-lite', upstream: 'sensenova-6.8-flash-lite', name: '6.8 Flash Lite', context: 200000, images: false };
const OC = { id: 'opencode/space-bunny-free', name: 'space bunny free', images: false, context: 1048576 };

test('provider 条目：字段形状照抄 Qoder 原生落盘样本', () => {
  const provider = qoderProvider([SN], 'https://token.sensenova.cn/v1', 'sk-test', {
    source: 'sensenova', owner: SOURCE_OWNERS.sensenova,
    idOf: m => m.upstream, labelOf: m => m.id,
  });
  assert.equal(provider.baseUrl, 'https://token.sensenova.cn/v1');
  assert.equal(provider.apiKey, 'sk-test');
  assert.equal(provider.type, 'openai-compatible');
  assert.equal(provider.protocol, 'openai');
  assert.equal(provider.authType, 'bearer');
  assert.equal(provider.model, 'sensenova-6.8-flash');
  assert.equal(provider.displayName, '墨桥 · 日日新');
  assert.equal(provider.mobridgeOwner, SOURCE_OWNERS.sensenova);
  assert.equal(provider.models.length, 1);
  const entry = provider.models[0];
  assert.equal(entry.model, 'sensenova-6.8-flash');
  assert.equal(entry.displayName, 'SN · sensenova-6.8-flash');
  assert.equal(entry.contextWindow, 327680);
  assert.equal(entry.capabilities.vision, true);
  assert.deepEqual(entry.capabilities.thinking, { modes: ['enabled'], supportsEffort: true, supportedEffortLevels: ['low', 'high'] });
});

test('qoderModelEntry：没有思考档位时写空能力，不省键', () => {
  const entry = qoderModelEntry(SN2);
  assert.deepEqual(entry.capabilities.thinking, { modes: [], supportsEffort: false, supportedEffortLevels: [] });
  assert.equal(entry.contextWindow, 200000);
  assert.equal('contextWindow' in qoderModelEntry({ upstream: 'x', id: 'x', context: null }), false);
});

test('mergeQoderProviders：只动自己的键，用户自己的 qoder-custom-* 原样保留', () => {
  const document = {
    enabledPlugins: { 'a@x': true },
    providers: {
      'qoder-custom-11111111': { baseUrl: 'https://user.example.com/v1', apiKey: 'sk-user', models: [{ model: 'user-model' }] },
    },
  };
  const provider = qoderProvider([SN, SN2], 'https://token.sensenova.cn/v1', 'sk-test', {
    source: 'sensenova', owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  });
  const merged = mergeQoderProviders(document, provider, { providerKey: providerKeyOf('sensenova'), owner: SOURCE_OWNERS.sensenova });
  assert.equal(merged.enabledPlugins['a@x'], true);
  const keys = Object.keys(merged.providers);
  assert.deepEqual(keys.sort(), ['qoder-custom-11111111', providerKeyOf('sensenova')].sort());
  assert.equal(merged.providers['qoder-custom-11111111'].apiKey, 'sk-user');
  assert.equal(merged.providers[providerKeyOf('sensenova')].models.length, 2);
  // 用户自己的键名撞上我们的前缀也不会被摘掉：摘除只认 owner 标记。
  const document2 = { providers: { [providerKeyOf('sensenova')]: { apiKey: 'sk-user-owned' } } };
  const merged2 = mergeQoderProviders(document2, null, { providerKey: providerKeyOf('sensenova'), owner: SOURCE_OWNERS.sensenova });
  assert.equal(Object.keys(merged2.providers).length, 1, '没有我们标记的条目即使键名相似也不摘');
});

test('inspectQoderProviders：按来源分家计数，模型数为口径', () => {
  const document = {
    providers: {
      [providerKeyOf('sensenova')]: { mobridgeOwner: SOURCE_OWNERS.sensenova, models: [{ model: 'a' }, { model: 'b' }] },
      [providerKeyOf('opencode')]: { mobridgeOwner: SOURCE_OWNERS.opencode, models: [{ model: 'c' }] },
      'qoder-custom-22222222': { models: [{ model: 'user' }] },
    },
  };
  const info = inspectQoderProviders(document);
  assert.equal(info.owned, 3);
  assert.equal(info.sources.sensenova.count, 2);
  assert.equal(info.sources.opencode.count, 1);
  assert.equal(info.sources.atomcode.count, 0);
});

test('mergeQoderProviders：日日新写入绝不能摘掉 OpenCode 写的 provider（D-01 回归）', () => {
  const document = {
    providers: {
      [providerKeyOf('opencode')]: { mobridgeOwner: SOURCE_OWNERS.opencode, models: [{ model: 'oc-a' }] },
      'qoder-custom-4444': { models: [{ model: 'user' }] },
    },
  };
  const snProvider = qoderProvider([SN], 'https://token.sensenova.cn/v1', 'sk-test', {
    source: 'sensenova', owner: SOURCE_OWNERS.sensenova, idOf: m => m.upstream, labelOf: m => m.id,
  });
  const merged = mergeQoderProviders(document, snProvider, { providerKey: providerKeyOf('sensenova'), owner: SOURCE_OWNERS.sensenova });
  assert.deepEqual(Object.keys(merged.providers).sort(),
    [providerKeyOf('opencode'), 'qoder-custom-4444', providerKeyOf('sensenova')].sort(),
    '日日新写入后 OpenCode 的条目与用户条目都必须原样保留');
  // 反向：OpenCode 重写也只摘自己。
  const ocProvider = qoderProvider([OC], 'http://127.0.0.1:31980/v1', 'k', {
    source: 'opencode', owner: SOURCE_OWNERS.opencode,
  });
  const merged2 = mergeQoderProviders(merged, ocProvider, { providerKey: providerKeyOf('opencode'), owner: SOURCE_OWNERS.opencode });
  assert.ok(merged2.providers[providerKeyOf('sensenova')], 'OpenCode 重写后日日新条目还在');
});

test('syncQoderProviders：写入后可移除；同内容不重复写；键冲突让位给用户', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-qoder-'));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ enabledPlugins: {}, providers: { 'qoder-custom-3333': { apiKey: 'keep' } } }, null, 2));
  const options = { file, source: 'sensenova', owner: SOURCE_OWNERS.sensenova, allowEmpty: true, idOf: m => m.upstream, labelOf: m => m.id };
  const first = await syncQoderProviders([SN], 'https://token.sensenova.cn/v1', 'sk-test', options);
  assert.equal(first.changed, true);
  assert.equal(first.count, 1);
  const again = await syncQoderProviders([SN], 'https://token.sensenova.cn/v1', 'sk-test', options);
  assert.equal(again.changed, false, '同内容不重复写');
  const backup = (await fs.readdir(dir)).find(name => name.endsWith('.bak'));
  assert.ok(backup, '写入时留了一份备份');
  // 用户手工把我们的键换成了自己的内容（抹掉 owner 标记 = 接管）：移除不能动它。
  const text = await fs.readFile(file, 'utf8');
  const doc = JSON.parse(text);
  delete doc.providers[providerKeyOf('sensenova')];
  doc.providers[providerKeyOf('sensenova')] = { apiKey: 'user-took-the-key' };
  await fs.writeFile(file, JSON.stringify(doc, null, 2));
  const conflict = await syncQoderProviders([SN], 'https://token.sensenova.cn/v1', 'sk-test', options);
  assert.equal(conflict.conflict, true);
  // 移除：只摘自己（带 owner 标记）的 provider；被用户接管的条目原样保留。
  const removed = await syncQoderProviders([], '', '', options);
  assert.equal(removed.changed, true);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(after.providers), ['qoder-custom-3333', providerKeyOf('sensenova')]);
  assert.equal(after.providers[providerKeyOf('sensenova')].apiKey, 'user-took-the-key');
  await fs.rm(dir, { recursive: true, force: true });
});

test('resolveQoderConfig：MOBRIDGE_QODER_HOME 覆盖默认目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-qoderhome-'));
  await fs.writeFile(path.join(dir, 'settings.json'), '{}');
  const resolved = await resolveQoderConfig({ env: { MOBRIDGE_QODER_HOME: dir }, home: os.homedir() });
  assert.equal(resolved.exists, true);
  assert.equal(resolved.file, path.join(dir, 'settings.json'));
  await fs.rm(dir, { recursive: true, force: true });
});
