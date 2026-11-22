import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pickPathPatch, validateTargetPath, locateWorkbuddyFile } from '../../src/service/config/target-paths.ts';
import { locateDshHome } from '../../src/service/config/dsh-config.ts';
import { mofangCandidates, resolveMofangConfig } from '../../src/service/config/mofang-config.ts';
import {
  TARGET_PATH_KEY, TARGET_PATH_KIND, PATH_TARGET, TARGET_PATH_KEYS,
} from '../../src/shared/target-path-keys.ts';

// 用户把客户端数据目录搬走后，墨桥还按固定目录找配置 → 模型写进一份客户端不读的文件。
// 这组用例锁住「设置里指定的路径」如何被挑出、校验、并优先于环境变量/默认目录。

test('键名映射：五个目标各有一个覆写键，方向可逆', () => {
  assert.deepEqual(TARGET_PATH_KEYS, ['workBuddyModelsFile', 'dshHome', 'mofangConfigFile', 'qoderConfigFile', 'traeStateFile']);
  for (const key of TARGET_PATH_KEYS) assert.equal(TARGET_PATH_KEY[PATH_TARGET[key]], key);
  assert.equal(TARGET_PATH_KIND.dsh, 'directory');
  assert.equal(TARGET_PATH_KIND.workbuddy, 'file');
  assert.equal(TARGET_PATH_KIND.mofang, 'file');
  assert.equal(TARGET_PATH_KIND.qoder, 'file');
  assert.equal(TARGET_PATH_KIND.trae, 'file');
});

test('pickPathPatch：只收五个键、trim、空值 = 恢复默认', () => {
  assert.deepEqual(pickPathPatch({ workBuddyModelsFile: '  /tmp/wb/models.json  ' }),
    { workBuddyModelsFile: '/tmp/wb/models.json' });
  assert.deepEqual(pickPathPatch({ dshHome: '', mofangConfigFile: null, port: 9999 }),
    { dshHome: null, mofangConfigFile: null });
  assert.deepEqual(pickPathPatch({ unrelated: 'x' }), {});
  assert.deepEqual(pickPathPatch(null), {});
});

test('pickPathPatch：不可信输入一律拒绝，不悄悄写进 settings.json', () => {
  assert.throws(() => pickPathPatch({ dshHome: 123 }), /必须是文本/);
  assert.throws(() => pickPathPatch({ dshHome: 'a\0b' }), /不合法/);
  assert.throws(() => pickPathPatch({ dshHome: 'x'.repeat(4097) }), /不合法/);
});

test('saved 优先于环境变量，环境变量优于默认目录', () => {
  const env = { DSH_HOME: 'C:\\env-dsh', MOFANG_HOME: 'C:\\env-mofang' };
  const home = path.join(os.homedir(), 'nonexistent-home-for-test');
  assert.equal(locateDshHome({ env, home, saved: 'C:\\my-dsh' }), path.resolve('C:\\my-dsh'));
  assert.equal(locateDshHome({ env, home }), path.resolve('C:\\env-dsh'));
  assert.equal(locateDshHome({ env: {}, home }), path.join(home, '.dsh'));

  assert.deepEqual(mofangCandidates({ env, home, savedFile: 'D:\\custom\\config.json' }),
    [path.resolve('D:\\custom\\config.json')]);
  assert.deepEqual(mofangCandidates({ env, home }), [path.join(path.resolve('C:\\env-mofang'), 'config.json')]);
  assert.equal(mofangCandidates({ env: {}, home }).length, 2, '未指定时保留新旧两个候选');
});

test('resolveMofangConfig：手动指定后不再回落到其它目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-path-'));
  try {
    const file = path.join(dir, 'my-config.json');
    await fs.writeFile(file, '{"providers":[]}');
    const got = await resolveMofangConfig({ savedFile: file, env: { MOFANG_HOME: dir }, home: dir });
    assert.equal(got.file, file);
    assert.equal(got.exists, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('locateWorkbuddyFile：纯本地扫描，不依赖模型服务，找到即返回', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-locate-'));
  try {
    await fs.mkdir(path.join(dir, '.workbuddy'));
    const models = path.join(dir, '.workbuddy', 'models.json');
    await fs.writeFile(models, '[]');
    assert.equal(await locateWorkbuddyFile({ env: {}, home: dir, scanDrives: false }), models);
    // 形状不对的文件不能被当作找到（validateModelsFile 会拒）
    await fs.writeFile(models, '{"not":"a model list"}');
    assert.equal(await locateWorkbuddyFile({ env: {}, home: dir, scanDrives: false }), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('validateTargetPath：三种形态分别校验，找不到就明确报错', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobridge-path-'));
  try {
    const models = path.join(dir, 'models.json');
    await fs.writeFile(models, '[]');
    await assert.doesNotReject(validateTargetPath('workbuddy', models));

    const config = path.join(dir, 'config.json');
    await fs.writeFile(config, '\uFEFF{"providers":[]}');
    await assert.doesNotReject(validateTargetPath('mofang', config));

    const dsh = path.join(dir, 'dsh');
    await fs.mkdir(path.join(dsh, 'profiles'), { recursive: true });
    await assert.doesNotReject(validateTargetPath('dsh', dsh));

    // 既有约束：WorkBuddy 只认名为 models.json 的文件，改名/不存在都直接拒绝。
    await assert.rejects(validateTargetPath('workbuddy', path.join(dir, 'missing.json')), /请选择|读不到|不是/);
    await assert.rejects(validateTargetPath('mofang', models), /格式不对|providers/);
    await assert.rejects(validateTargetPath('dsh', dir), /profiles/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
