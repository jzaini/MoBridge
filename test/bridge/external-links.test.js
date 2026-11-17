import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedExternal, EXTERNAL_HOSTS } from '../../src/shared/constants.ts';

// 外链白名单回归：页面上每个「官网 ↗」按钮指向的 URL 必须真的能出白名单，
// 否则点击后 { ok: false } 静默不动——用户会以为按钮坏了。
// 这组用例把「页面用到的链接」和「constants.ts 的白名单」锁成同一份事实。

test('页面上实际引用的官方链接全部能通过白名单', () => {
  const usedInPages = [
    // 日日新（SensenovaView）
    'https://platform.sensenova.cn/console',   // 打开日日新控制台
    'https://platform.sensenova.cn/docs',      // 官方文档
    // AtomCode（AtomCodeView，config/atomcode.ts 的 OFFICIAL_SITE / OFFICIAL_DOC）
    'https://atomcode.atomgit.com',                                  // 官网
    'https://atomcode.atomgit.com/docs/zh/getting-started.html',     // 官方文档
  ];
  for (const url of usedInPages) {
    // isAllowedExternal 返回 URL 规范化后的字符串（裸域名会补结尾斜杠），
    // shell.openExternal 打开的正是这个规范化结果，行为正确。
    assert.equal(isAllowedExternal(url), new URL(url).toString(), '应放行: ' + url);
  }
});

test('白名单内的域名覆盖清单', () => {
  // 新增官网链接时如果忘了把域名加进白名单，这里会先红。
  assert.deepEqual([...EXTERNAL_HOSTS].sort(), [
    'atomcode.atomgit.com',
    'atomgit.com',
    'platform.sensenova.cn',
    'token.sensenova.cn',
  ]);
});

test('非 https、白名单外、垃圾输入一律拒绝', () => {
  assert.equal(isAllowedExternal('http://atomcode.atomgit.com'), null, 'http 不放行');
  assert.equal(isAllowedExternal('https://evil.example.com'), null, '陌生域名不放行');
  assert.equal(isAllowedExternal('https://atomgit.com.evil.io'), null, '后缀伪装不放行');
  assert.equal(isAllowedExternal('file:///C:/Windows/System32/calc.exe'), null);
  assert.equal(isAllowedExternal('not a url'), null);
  assert.equal(isAllowedExternal(''), null);
});
