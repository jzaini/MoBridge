import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, cleanOutput } from '../src/shared/failure.ts';

// 用户的原话是「这个错误提示怎么英文中文都有啊？」——
// 起因是 AtomCode 登录失败时把 CLI 原文直接贴进了浮层。
// 这组用例锁住两件事：① 常见上游/本机报错都给一句中文结论；② 原文进 detail，不丢。

test('AtomCode 交互式终端报错翻成中文并给出下一步', () => {
  const raw = 'Windows interactive mode requires console input and output; this terminal provides pipes.\r\n'
    + 'In MobaXterm, launch with \'winpty atomcode.exe login\'.';
  const copy = describeFailure(raw);
  assert.match(copy.summary, /交互式终端/);
  assert.match(copy.summary, /atomcode login/);
  // 原文必须留着：翻译会丢细节，排查时还要看得到。只把 \r\n 归一成 \n，行结构保留。
  assert.equal(copy.detail, 'Windows interactive mode requires console input and output; this terminal provides pipes.\n'
    + 'In MobaXterm, launch with \'winpty atomcode.exe login\'.');
});

test('额度与地区限制各说各的', () => {
  assert.match(describeFailure('Free usage exceeded, subscribe to Go').summary, /额度用尽/);
  assert.match(describeFailure('This model is not available in your country').summary, /地区不可用/);
});

test('规则优先级：额度报错不会被后面的宽泛规则抢走', () => {
  // 同一段文本里既有 quota 又有 timeout 字样时，先说额度——那才是用户要处理的因。
  assert.match(describeFailure('quota exhausted: request timeout').summary, /额度用尽/);
});

test('鉴权、网络、超时、端口占用都有中文结论', () => {
  assert.match(describeFailure('401 Unauthorized').summary, /鉴权没通过/);
  assert.match(describeFailure('fetch failed: ECONNREFUSED 127.0.0.1:31280').summary, /连不上上游/);
  assert.match(describeFailure('ETIMEDOUT').summary, /超时/);
  assert.match(describeFailure('listen EADDRINUSE: address already in use 127.0.0.1:31280').summary, /端口被占用/);
});

test('没见过的报错不留空，只说第一行', () => {
  const copy = describeFailure('some brand new failure\nwith a second line');
  assert.equal(copy.summary, 'some brand new failure');
  assert.match(copy.detail, /second line/);
});

test('第一行过长时截断，浮层不铺长文', () => {
  const copy = describeFailure('x'.repeat(200));
  assert.equal(copy.summary.length, 91);
  assert.ok(copy.summary.endsWith('…'));
});

test('空报错回落到调用方给的兜底文案', () => {
  assert.deepEqual(describeFailure(''), { summary: '操作失败' });
  assert.deepEqual(describeFailure(null, '写入失败'), { summary: '写入失败' });
  assert.deepEqual(describeFailure(undefined), { summary: '操作失败' });
  assert.deepEqual(describeFailure(new Error('')), { summary: '操作失败' });
});

test('Error 对象取 message，不把 "Error: " 前缀带进浮层', () => {
  const copy = describeFailure(new Error('401 Unauthorized'));
  assert.match(copy.summary, /鉴权没通过/);
  assert.ok(!copy.summary.startsWith('Error'));
});

test('ANSI 颜色码与多余空白先清掉再匹配', () => {
  assert.equal(cleanOutput('\u001B[31mred\u001B[0m\r\n\r\n\r\ntail'), 'red\n\ntail');
  assert.match(describeFailure('\u001B[31mFree usage exceeded\u001B[0m').summary, /额度用尽/);
});
