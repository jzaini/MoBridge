// mergeProvider 的家族命名空间语义（S-28 同期实锤，2026-11-28）：
// 墨坊配置里 mobridge* 前缀 = 墨桥写的；旧版条目可能还没带 owner 字段，
// 必须按「迁移」替换而不是报 MOFANG_ID_CONFLICT 卡死写入；用户自建 id 才冲突让位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProvider } from '../../src/service/config/mofang-config.ts';
import { OWNER } from '../../src/service/sync/sync.ts';

const DOC = user => ({ providers: [user, ...(user ? [] : [])], activeProvider: user?.id ?? null });

test('mergeProvider：旧版写入的无 owner 同 id 条目（家族命名空间内）按迁移替换', () => {
  const doc = {
    providers: [
      { id: 'deepseek', name: 'DeepSeek', apiKey: 'sk-user' },
      // 旧版墨桥写的：没有 owner 字段，id 是家族命名空间
      { id: 'mobridge-sensenova', name: '墨桥 · 日日新', apiKey: 'sk-legacy', models: [{ id: 'old' }] },
    ],
    activeProvider: 'mobridge-sensenova',
  };
  const incoming = { id: 'mobridge-sensenova', name: '墨桥 · 日日新', apiKey: 'sk-new', models: [{ id: 'new' }], mobridgeOwner: 'mobridge-sensenova-v1' };
  const merged = mergeProvider(doc, incoming, { providerId: 'mobridge-sensenova', owner: 'mobridge-sensenova-v1' });
  assert.equal(merged.providers.length, 2, '用户条目 + 迁移后的墨桥条目');
  const ours = merged.providers.find(p => p.id === 'mobridge-sensenova');
  assert.equal(ours.apiKey, 'sk-new', '旧条目被新形状替换');
  assert.equal(ours.mobridgeOwner, 'mobridge-sensenova-v1', '迁移后带上 owner 标记');
  assert.equal(merged.providers.find(p => p.id === 'deepseek').apiKey, 'sk-user', '用户条目原样保留');
});

test('mergeProvider：用户自建同 id（非家族命名空间）冲突让位', () => {
  const doc = { providers: [{ id: 'my-own-provider', name: '我自己的', apiKey: 'sk-user' }] };
  assert.throws(
    () => mergeProvider(doc, { id: 'my-own-provider' }, { providerId: 'my-own-provider', owner: OWNER }),
    /用户自建/,
  );
  try {
    mergeProvider(doc, { id: 'my-own-provider' }, { providerId: 'my-own-provider', owner: OWNER });
  } catch (e) {
    assert.equal(e.code, 'MOFANG_ID_CONFLICT');
  }
});

test('mergeProvider：用户自建同 id 且调用方 id 在命名空间内——providerId 决定命名空间归属', () => {
  // providerId='mobridge-sensenova'（家族命名空间）→ 磁盘上同名条目按迁移处理
  const doc = { providers: [{ id: 'mobridge-sensenova', name: '旧版残留', apiKey: 'sk-old' }] };
  const merged = mergeProvider(doc, { id: 'mobridge-sensenova', apiKey: 'sk-new' }, { providerId: 'mobridge-sensenova', owner: OWNER });
  assert.equal(merged.providers.length, 1);
  assert.equal(merged.providers[0].apiKey, 'sk-new');
});

test('mergeProvider：provider=null 移除时连旧版无 owner 的同 id 条目一起摘', () => {
  const doc = {
    providers: [
      { id: 'deepseek', apiKey: 'sk-user' },
      { id: 'mobridge-sensenova', apiKey: 'sk-legacy' }, // 无 owner 字段的旧条目
    ],
  };
  const merged = mergeProvider(doc, null, { providerId: 'mobridge-sensenova', owner: 'mobridge-sensenova-v1' });
  assert.deepEqual(merged.providers.map(p => p.id), ['deepseek'], '用户条目保留，旧墨桥条目被摘除');
});

test('mergeProvider：其他来源的墨桥条目不受本次写入影响', () => {
  const doc = {
    providers: [
      { id: 'mobridge', apiKey: 'sk-oc', mobridgeOwner: 'mobridge-v1' },
      { id: 'mobridge-sensenova', apiKey: 'sk-old' },
    ],
  };
  const merged = mergeProvider(doc, { id: 'mobridge-sensenova', apiKey: 'sk-new' }, { providerId: 'mobridge-sensenova', owner: 'mobridge-sensenova-v1' });
  assert.equal(merged.providers.find(p => p.id === 'mobridge').apiKey, 'sk-oc', 'OpenCode 线条目原样保留');
  assert.equal(merged.providers.find(p => p.id === 'mobridge-sensenova').apiKey, 'sk-new', '本线旧条目被替换');
});
