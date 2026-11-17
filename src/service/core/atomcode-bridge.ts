import http from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { upstreamChat } from '../domain/atomcode.ts';

// AtomCode 的本机转发口。为什么必须单独开一个：
// 上游要注入 X-AtomCode-* 那组头和 Bearer token，客户端自己做不到；
// 而主转发口走的是 OpenCode 的信封协议与审批围栏，两套语义不能混在一个端口上。
// 这里只做一件事：把客户端的 `AC · xxx` 映射回上游真名，加上头，原样转发出去。
const MAX_BODY = 8 * 1024 * 1024;

function authorized(req: http.IncomingMessage, key: string) {
  const actual = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from('Bearer ' + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_BODY) throw new Error('请求超过 8 MB');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export interface AtomcodeBridgeState {
  models: Array<{ id: string, upstream: string }>;
  token: string | null;
  gateway: string;
}

export async function startAtomcodeBridge({ dataDir, getState, port }: {
  dataDir: string;
  getState: () => AtomcodeBridgeState;
  port?: number;
}) {
  // 自己的口令文件：与主转发口的 key 分开，撤掉这一路不会动到另一路。
  const keyFile = path.join(dataDir, 'atomcode-key');
  let key: string;
  try { key = (await fs.readFile(keyFile, 'utf8')).trim(); }
  catch { key = randomBytes(32).toString('hex'); await fs.writeFile(keyFile, key + '\n', { mode: 0o600, flag: 'wx' }); }

  // 端口由服务层从设置里算好后传进来；这里留 31282 只是独立跑时的兜底。
  const listenPort = port ?? Number(process.env.MOBRIDGE_ATOMCODE_PORT || 31282);
  // 实际监听端口由系统决定（传 0 时），对外报告的地址必须和它一致，所以先占位再回填。
  let boundPort = listenPort;
  const active = new Set<AbortController>();
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Local API key required' } });
    if (req.headers.origin) return json(res, 403, { error: { message: 'Browser-origin requests are disabled' } });
    const route = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const state = getState();
      if (req.method === 'GET' && route === '/health')
        return json(res, 200, { ok: true, provider: 'atomcode', endpoint: `http://127.0.0.1:${boundPort}`, models: state.models.length, loggedIn: !!state.token });
      if (req.method === 'GET' && route === '/v1/models')
        return json(res, 200, { object: 'list', data: state.models.map(model => ({ id: model.id, object: 'model', owned_by: 'atomcode', name: model.id })) });
      if (req.method !== 'POST' || route !== '/v1/chat/completions')
        return json(res, 404, { error: { message: 'Not found' } });
      if (active.size > 4) return json(res, 429, { error: { message: 'At most four requests may run at once' } });
      if (!state.token) return json(res, 503, { error: { message: 'AtomCode 未登录或 token 已失效，请在接入页重新登录' } });
      if (!state.models.length) return json(res, 503, { error: { message: '没有可用模型，请先刷新 CodingPlan 目录' } });
      const body = await readBody(req);
      const original = body.model;
      // 客户端发来的可能是展示名（`AC · xxx`），也可能是上游真名（旧配置/手写配置）。
      // 两种都认，但认不出来时不能悄悄改投第一个模型——那会让用户选了 A 却跑在 B 上，
      // 还看不出任何异常，所以这里直接报错并列出可用模型。
      const found = state.models.find(model => model.id === original)
        ?? state.models.find(model => model.upstream === original);
      if (!found) {
        const available = state.models.map(model => model.id).join('、') || '（空）';
        return json(res, 404, { error: { message: `未知模型 ${String(original)}；可用模型：${available}`, type: 'model_not_found', code: 'model_not_found' } });
      }
      const upstream = found.upstream;
      body.model = upstream;
      const response = await upstreamChat(state.gateway, state.token, body, controller.signal);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return json(res, response.status >= 500 ? 502 : response.status,
          { error: { message: `上游 HTTP ${response.status}${text ? '：' + text.slice(0, 300) : ''}` } });
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        if (!response.body) return res.end();
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
        await new Promise<void>(resolve => { res.on('close', () => resolve()); res.on('finish', () => resolve()); });
      } else {
        const payload = await response.json() as Record<string, unknown>;
        // 客户端只认得自己给的那个 id，把上游真名换回去。
        payload.model = original;
        json(res, 200, payload);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = (error as Error).name === 'TimeoutError' ? '模型请求超时' : (error as Error).message;
      if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { message } }) + '\n\n');
      else json(res, 502, { error: { message } });
    } finally { active.delete(controller); }
  });
  // 推理可能很慢，请求体与头各有上限就够了，整请求不设超时。
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve());
  });
  boundPort = (server.address() as { port: number } | null)?.port ?? listenPort;
  const close = () => { for (const controller of active) controller.abort(); server.close(); };
  return { port: boundPort, key, endpoint: `http://127.0.0.1:${boundPort}`, close };
}
