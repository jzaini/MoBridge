import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startAtomcodeBridge } from '../src/service/core/atomcode-bridge.ts';

// 转发口的职责只有一条：把客户端发来的名字认出来，换成上游真名再带着签名头送出去。
// 这里锁的是两个曾经踩过的点——认不出模型时静默改投第一个模型、以及客户端发回来的是
// 配置里写下的展示名（`AC · xxx`）而不是上游真名。

const MODELS = [
  { id: 'AC · glm5.3-flash', upstream: 'glm5.3-flash' },
  { id: 'AC · qwen3.8-27b', upstream: 'qwen3.8-27b' },
];
const TOKEN = 'atom-token';

async function withBridge(run) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-1', model: 'upstream-name', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }] }));
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
