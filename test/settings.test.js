import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, pickKnownKeys, SETTINGS_DEFAULTS, SETTINGS_LIMITS } from '../src/service/domain/settings.ts';

// 设置是从磁盘/面板读进来的不可信数据：缺字段、多字段、写成字符串、写进 null 都遇到过。
// 这里的用例就是保证"无论读到什么，服务拿到的都是一份能用的完整设置"。

test('空输入回落到默认值', () => {
  assert.deepEqual(normalizeSettings(), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalizeSettings(null), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalizeSettings(undefined), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalizeSettings([]), { ...SETTINGS_DEFAULTS });
  assert.deepEqual(normalizeSettings('nonsense'), { ...SETTINGS_DEFAULTS });
});

test('未知键被丢弃，不写回 settings.json', () => {
  const normalized = normalizeSettings({ ...SETTINGS_DEFAULTS, target: 'dsh', excludedModels: ['x'], 随便: 1 });
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(SETTINGS_DEFAULTS).sort());
});

test('数字超出区间时按区间夹紧（手滑多打一个零不会让检测全灭）', () => {
  const low = normalizeSettings({ probeTimeoutMs: 1, probeConcurrency: 0, sensenovaTimeoutMs: -5 });
  assert.equal(low.probeTimeoutMs, SETTINGS_LIMITS.probeTimeoutMs.min);
  assert.equal(low.probeConcurrency, SETTINGS_LIMITS.probeConcurrency.min);
  assert.equal(low.sensenovaTimeoutMs, SETTINGS_LIMITS.sensenovaTimeoutMs.min);

  const high = normalizeSettings({ probeTimeoutMs: 9_999_999, probeConcurrency: 99, probeCacheMinutes: 999_999 });
  assert.equal(high.probeTimeoutMs, SETTINGS_LIMITS.probeTimeoutMs.max);
  assert.equal(high.probeConcurrency, SETTINGS_LIMITS.probeConcurrency.max);
  assert.equal(high.probeCacheMinutes, SETTINGS_LIMITS.probeCacheMinutes.max);
});

test('输入框送来的字符串数字能用（面板里的 NInputNumber 有时是字符串）', () => {
  const normalized = normalizeSettings({ probeTimeoutMs: '45000', probeConcurrency: '2' });
  assert.equal(normalized.probeTimeoutMs, 45000);
  assert.equal(normalized.probeConcurrency, 2);
});

test('非法数字回落到默认值，而不是变成 NaN 卡死检测', () => {
  const normalized = normalizeSettings({ probeTimeoutMs: 'abc', probeConcurrency: NaN, rejectTtlMinutes: Infinity });
  assert.equal(normalized.probeTimeoutMs, SETTINGS_DEFAULTS.probeTimeoutMs);
  assert.equal(normalized.probeConcurrency, SETTINGS_DEFAULTS.probeConcurrency);
  assert.equal(normalized.rejectTtlMinutes, SETTINGS_DEFAULTS.rejectTtlMinutes);
});

test('小数会被取整：并发 2.7 个 worker 没有意义', () => {
  assert.equal(normalizeSettings({ probeConcurrency: 2.7 }).probeConcurrency, 3);
  assert.equal(normalizeSettings({ probeTimeoutMs: 45000.6 }).probeTimeoutMs, 45001);
});

test('probeCacheMinutes 允许 0 = 不复用', () => {
  assert.equal(normalizeSettings({ probeCacheMinutes: 0 }).probeCacheMinutes, 0);
});

test('布尔开关接受 true/false 与字符串，其余回落默认', () => {
  assert.equal(normalizeSettings({ autoProbeOnStart: false }).autoProbeOnStart, false);
  assert.equal(normalizeSettings({ autoProbeOnStart: 'false' }).autoProbeOnStart, false);
  assert.equal(normalizeSettings({ autoProbeOnStart: 1 }).autoProbeOnStart, true);
  assert.equal(normalizeSettings({ autoProbeOnStart: 'maybe' }).autoProbeOnStart, SETTINGS_DEFAULTS.autoProbeOnStart);
});

test('pickKnownKeys 只挑设置字段，其它一概不接', () => {
  assert.deepEqual(pickKnownKeys({ probeTimeoutMs: 30000, target: 'dsh' }), { probeTimeoutMs: 30000 });
  assert.deepEqual(pickKnownKeys(null), {});
  assert.deepEqual(pickKnownKeys([]), {});
  // 显式写成 null 也算"用户动过这个字段"，交给 normalize 决定回落。
  assert.deepEqual(pickKnownKeys({ probeConcurrency: null }), { probeConcurrency: null });
});

test('端口：默认值是新号段，且不沿用旧产品端口', () => {
  assert.equal(SETTINGS_DEFAULTS.port, 31280);
  assert.equal(SETTINGS_DEFAULTS.atomcodePort, 31282);
  // 41980/41982 是上一代产品的号段，出现在默认值里说明又绑回去了。
  assert.notEqual(SETTINGS_DEFAULTS.port, 41980);
  assert.notEqual(SETTINGS_DEFAULTS.atomcodePort, 41982);
});

test('端口：越界被夹回，字符串数字能用', () => {
  assert.equal(normalizeSettings({ port: 80 }).port, 1024);
  assert.equal(normalizeSettings({ port: 99999 }).port, 65535);
  assert.equal(normalizeSettings({ port: '31300' }).port, 31300);
  assert.equal(normalizeSettings({ atomcodePort: 'abc' }).atomcodePort, SETTINGS_DEFAULTS.atomcodePort);
});

test('端口：两个口分别可配，互不影响', () => {
  const normalized = normalizeSettings({ port: 32000 });
  assert.equal(normalized.port, 32000);
  // 只改主口时 AtomCode 口保持自己的默认值，由主进程决定要不要跟着 +2。
  assert.equal(normalized.atomcodePort, SETTINGS_DEFAULTS.atomcodePort);
});
