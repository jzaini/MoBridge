import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startAtomcodeBridge } from '../../src/service/core/atomcode-bridge.ts';
import { wrappedUpstreamError, probePlanModels } from '../../src/service/domain/atomcode.ts';

// 转发口的职责只有一条：把客户端发来的名字认出来，换成上游真名再带着签名头送出去。
// 这里锁的是两个曾经踩过的点——认不出模型时静默改投第一个模型、以及客户端发回来的是
// 配置里写下的展示名（`AC · xxx`）而不是上游真名。
// 2026-11-18 又补一类：上游把拒绝伪装成 200 + 助手回复（"参数错误"），必须还原成真实错误。

const MODELS = [
  { id: 'AC · glm5.3-flash', upstream: 'glm5.3-flash' },
  { id: 'AC · qwen3.8-27b', upstream: 'qwen3.8-27b' },
];
const TOKEN = 'atom-token';

// responder 自定义上游响应：默认正常回答；测"伪装错误"时返回 200 + 错误文本或 SSE。
async function withBridge(run, responder) {
  const seen = [];
  const reply = responder ?? (() => ({ status: 200, payload: { id: 'chatcmpl-1', model: 'upstream-name', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] } }));
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      const { status = 200, payload = {}, raw = null } = reply(JSON.parse(body || '{}'));
      res.writeHead(status, { 'Content-Type': raw ? 'text/event-stream' : 'application/json' });
      res.end(raw ?? JSON.stringify(payload));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mb-ac-bridge-'));
  const bridge = await startAtomcodeBridge({
    dataDir: dir,
    getState: () => ({ models: MODELS, token: TOKEN, gateway: `http://127.0.0.1:${upstream.address().port}` }),
    port: 0, // 由系统分配空闲端口，避免和真实运行时抢 41982
  });
  try {
    return await run({ bridge, seen, port: bridge.port, key: bridge.key });
  } finally {
    bridge?.close();
    await new Promise(resolve => upstream.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const post = (port, key, body) => new Promise((resolve, reject) => {
  const payload = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer ' + key } },
    res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); });
  req.on('error', reject);
  req.write(payload);
  req.end();
});

test('转发口：展示名换成上游真名，并把上游名字换回客户端给的那个', async () => {
  await withBridge(async ({ port, key, seen }) => {
    const response = await post(port, key, { model: 'AC · qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).model, 'AC · qwen3.8-27b');
    assert.equal(seen[0].body.model, 'qwen3.8-27b');
    assert.ok(seen[0].headers['x-atomcode-sig'], '要带上 AtomCode 签名头');
  });
});

test('转发口：也认上游真名（旧配置里写的是真名）', async () => {
  await withBridge(async ({ port, key, seen }) => {
    const response = await post(port, key, { model: 'glm5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 200);
    assert.equal(seen[0].body.model, 'glm5.3-flash');
  });
});

test('转发口：认不出的模型明确报错，不悄悄改投第一个', async () => {
  await withBridge(async ({ port, key, seen }) => {
    const response = await post(port, key, { model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 404);
    const error = JSON.parse(response.text).error;
    assert.equal(error.code, 'model_not_found');
    assert.match(error.message, /未知模型/);
    assert.match(error.message, /AC · glm5\.3-flash/);
    assert.equal(seen.length, 0, '认不出模型就不该往上游发请求');
  });
});

test('转发口：口令不对一律 401', async () => {
  await withBridge(async ({ port }) => {
    const response = await post(port, 'wrong-key', { model: 'AC · glm5.3-flash', messages: [] });
    assert.equal(response.status, 401);
  });
});

test('转发口：上游伪装成回复的拒绝（非流式）还原成 502 真错误', async () => {
  await withBridge(async ({ port, key }) => {
    const response = await post(port, key, { model: 'AC · glm5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 502);
    const error = JSON.parse(response.text).error;
    assert.match(error.message, /上游拒绝了该模型：参数错误/);
  }, () => ({ status: 200, payload: { id: 'x', model: 'glm5.3-flash', choices: [{ index: 0, message: { role: 'assistant', content: '参数错误' }, finish_reason: 'stop' }] } }));
});

test('转发口：上游伪装成回复的拒绝（流式）被掐断并补发错误事件', async () => {
  await withBridge(async ({ port, key }) => {
    const response = await post(port, key, { model: 'AC · glm5.3-flash', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.equal(response.status, 200, 'SSE 头已经发出，状态码仍是 200');
    assert.ok(response.text.includes('上游拒绝了该模型'), '要补发真正的错误事件');
    assert.ok(!response.text.includes('"delta"'), '伪装成回复的内容不能再转发给客户端');
  }, () => ({
    status: 200,
    raw: 'data: ' + JSON.stringify({ choices: [{ delta: { content: '参数错误' } }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' + 'data: [DONE]\n\n',
  }));
});

test('转发口：正常长回答原样透传，不被误判成错误', async () => {
  await withBridge(async ({ port, key }) => {
    const long = '这是一条足够长的正常回答。'.repeat(30);
    const response = await post(port, key, { model: 'AC · glm5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).choices[0].message.content, long);
  }, () => ({ status: 200, payload: { id: 'x', model: 'glm5.3-flash', choices: [{ index: 0, message: { role: 'assistant', content: '这是一条足够长的正常回答。'.repeat(30) } }] } }));
});

test('包装错误识别：参数错误与三方请求失败命中，正常回答不命中', () => {
  assert.equal(wrappedUpstreamError('参数错误'), '参数错误');
  assert.match(wrappedUpstreamError('三方请求失败: 404 {"error":{"code":"ModelArts.81009"}}'), /三方请求失败/);
  assert.equal(wrappedUpstreamError('你好！有什么可以帮您？'), null);
  assert.equal(wrappedUpstreamError(''), null);
  assert.equal(wrappedUpstreamError(null), null);
});

test('模型可用性探测：哨兵词命中=可用，包装错误=拒绝，网络故障=不下结论', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === 'good-model') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
    }
    if (body.model === 'dead-model') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '参数错误' } }] }) };
    }
    throw new Error('ECONNREFUSED');
  };
  const results = await probePlanModels('https://gateway.test', 'token', [
    { upstream: 'good-model' }, { upstream: 'dead-model' }, { upstream: 'net-model' },
  ], { fetchImpl });
  assert.equal(results['good-model'].reason, 'ok');
  assert.equal(results['dead-model'].reason, 'rejected');
  assert.equal(results['dead-model'].detail, '参数错误');
  assert.equal(results['net-model'].reason, 'inconclusive');
});
