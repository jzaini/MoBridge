import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { upstreamChat, wrappedUpstreamError } from '../domain/atomcode.ts';

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

const TRIP_ADVICE = '模型可能已从当前套餐下线或未启用，请回墨桥刷新目录重新校验。';

// 流式转发前的"谎言过滤"：上游拒绝时把错误文本伪装成助手回复（SSE delta），
// 一路转发的话客户端会把"参数错误"当成 AI 的回答。这里边转发边累计 delta 文本，
// 一旦命中包装错误特征（见 domain/atomcode.ts 的 wrappedUpstreamError）就停止放行，
// 由调用方补发一条真正的错误事件。正常回答超过 200 字符还没命中就放弃检查，零开销直通。
function sseErrorFilter(onTrip: (wrapped: string) => void): Transform {
  let buf = '';
  let acc = '';
  let live = true;
  return new Transform({
    transform(chunk, _enc, done) {
      if (live) {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const payload = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> };
            acc += String(payload.choices?.[0]?.delta?.content ?? '');
          } catch { /* 噪音行放行，不影响转发 */ }
          if (acc.length > 200) { live = false; break; }
          const wrapped = wrappedUpstreamError(acc);
          if (wrapped) { live = false; onTrip(wrapped); break; }
        }
      }
      if (live) done(null, chunk); else done();
    },
  });
}

export interface AtomcodeBridgeState {
  models: Array<{ id: string, upstream: string }>;
  token: string | null;
  gateway: string;
}

/** 账本上报信息（T1.4）：model 用上游真名，渠道名由调用方（main.ts）统一标 atomcode。 */
export interface AtomcodeCallInfo {
  software: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  status?: number;
  category?: string;
  usage?: Record<string, unknown> | null;
}

/** 接出方暂无契约：优先自定义头，退回 user-agent，再退 unknown（与主转发口同款规则）。 */
function clientSoftware(req: http.IncomingMessage) {
  return String(req.headers['x-mobridge-client'] || req.headers['user-agent'] || 'unknown').slice(0, 120);
}

export interface DaemonCompleteResult {
  content: string;
  tool_calls: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>;
  reasoning: string;
}

export async function startAtomcodeBridge({ dataDir, getState, port, daemon, onCall }: {
  dataDir: string;
  getState: () => AtomcodeBridgeState;
  port?: number;
  /** daemon 优先路径：签名在 daemon 内完成、直连真端点；返回 null 或抛错时回落 api-ai 网关。 */
  daemon?: { complete(upstream: string, messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<DaemonCompleteResult | null> };
  /** 墨镜账本回调（T1.4）：每次真实转发收尾时调一次；实现方自己吞错，这里不 await 不感知失败。 */
  onCall?: (info: AtomcodeCallInfo) => void;
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
    // 账本（T1.4）在 try 外声明：上游真名解析后回填 ledgerModel，解析前的失败
    // （429/未知模型/JSON 错误）不算上游调用，不记。TDZ 安全——catch 里随时可调。
    const ledgerStarted = performance.now();
    let ledgerModel: string | null = null;
    const ledgerReport = (info: Partial<AtomcodeCallInfo>) => {
      if (!ledgerModel) return;
      try {
        onCall?.({ software: clientSoftware(req), model: ledgerModel, ok: false, latencyMs: Math.round(performance.now() - ledgerStarted), ...info });
      } catch { /* 记账是旁路：这里之外不再抛 */ }
    };
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
      ledgerModel = upstream; // 账本从这一刻起才认为"一次上游调用"成立
      // daemon 优先：签名由 daemon 用用户自己的登录态完成、直连 llm-api 真端点；
      // 不可用（未安装/未登录/启动失败）或调用失败时回落 api-ai 网关薄代理。
      if (daemon) {
        try {
          const reply = await daemon.complete(upstream, body.messages ?? [], body.tools ?? [], controller.signal);
          if (reply) {
            const message: Record<string, unknown> = { role: 'assistant', content: reply.content };
            if (reply.reasoning) message.reasoning_content = reply.reasoning;
            if (reply.tool_calls.length) message.tool_calls = reply.tool_calls;
            const payload = {
              id: 'chatcmpl-' + randomBytes(12).toString('hex'),
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: original,
              choices: [{ index: 0, message, finish_reason: reply.tool_calls.length ? 'tool_calls' : 'stop' }],
            };
            // 客户端要流式就按 SSE 一次性下发（daemon 已聚合完毕），否则直接 JSON。
            ledgerReport({ ok: true }); // daemon 聚合路径不透出 usage：缺失记 null，墨镜单列计数
            if (body.stream) {
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
              const delta: Record<string, unknown> = { role: 'assistant', content: reply.content };
              if (reply.reasoning) delta.reasoning_content = reply.reasoning;
              if (reply.tool_calls.length) delta.tool_calls = reply.tool_calls;
              res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }] }) + '\n\n');
              res.end('data: [DONE]\n\n');
              return;
            }
            return json(res, 200, payload);
          }
        } catch (error) {
          // daemon 路径失败不直接报给客户端：回落网关，若网关也失败才真正报错。
          if (controller.signal.aborted) return;
        }
      }
      const response = await upstreamChat(state.gateway, state.token, body, controller.signal);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        ledgerReport({ ok: false, status: response.status, error: `上游 HTTP ${response.status}` });
        return json(res, response.status >= 500 ? 502 : response.status,
          { error: { message: `上游 HTTP ${response.status}${text ? '：' + text.slice(0, 300) : ''}` } });
      }
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        if (!response.body) return res.end();
        let tripped: string | null = null;
        const filter = sseErrorFilter(wrapped => { tripped = wrapped; });
        // end:false —— 掐断时管道不能抢先结束响应，错误事件由下面这段补发。
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(filter).pipe(res, { end: false });
        await new Promise<void>(resolve => {
          filter.once('end', () => resolve());
          filter.once('close', () => resolve());
          res.once('close', () => resolve());
        });
        // 掐断了伪装回复：补一条真正的错误事件收尾，客户端就能看到失败原因而不是"AI 说参数错误"。
        if (res.writableEnded || res.destroyed) return;
        // 账本：掐断 = 上游拒绝（失败）；正常走完 = 成功（流式拿不到 usage，记 null 不猜数）。
        if (tripped) ledgerReport({ ok: false, error: tripped });
        else if (!controller.signal.aborted) ledgerReport({ ok: true });
        if (tripped) {
          res.write('data: ' + JSON.stringify({ error: { message: `上游拒绝了该模型：${tripped}。${TRIP_ADVICE}` } }) + '\n\n');
        }
        res.end();
      } else {
        const payload = await response.json() as Record<string, unknown> & { choices?: Array<{ message?: { content?: unknown } }>, usage?: Record<string, unknown> };
        // 上游把拒绝伪装成 200 + 助手回复（见 domain/atomcode.ts），在这里还原成真实错误。
        const wrapped = wrappedUpstreamError(payload.choices?.[0]?.message?.content);
        if (wrapped) {
          ledgerReport({ ok: false, error: wrapped });
          return json(res, 502, { error: { message: `上游拒绝了该模型：${wrapped}。${TRIP_ADVICE}` } });
        }
        ledgerReport({ ok: true, usage: payload.usage ?? null });
        // 客户端只认得自己给的那个 id，把上游真名换回去。
        payload.model = original;
        json(res, 200, payload);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = (error as Error).name === 'TimeoutError' ? '模型请求超时' : (error as Error).message;
      // 账本：异常收尾也是一次真实调用的失败（TimeoutError 带分类提示，墨桥词表 → 墨镜映射）。
      ledgerReport({ ok: false, error: message, ...((error as Error).name === 'TimeoutError' ? { category: 'timeout' } : {}) });
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
