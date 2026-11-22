import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { clientModelID } from '../domain/model-status.ts';
import { prepare, sendSSE, BridgeError } from '../domain/protocol.ts';

// 本地转发口只服务于本机的原生客户端：Bearer 口令用定时安全比较，
// 浏览器来源一律拒绝（同源脚本没有理由访问推理接口）。
function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const MAX_BODY = 8 * 1024 * 1024;
async function readBody(req) {
  // 先看声明长度：声明就超限的请求没必要先读进 8MB 内存再拒绝。
  // 更关键的是——在 for await 里抛错会顺手销毁请求流，客户端那边只看到连接断掉、
  // 收不到 413，所以超限要先应答再丢掉剩余字节（resume），别让读流中途炸开。
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
    req.resume();
    throw new BridgeError('Request exceeds 8 MB', 413);
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      req.resume();
      throw new BridgeError('Request exceeds 8 MB', 413);
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

export function createServer({ server = http.createServer(), key, selectModel, backend, getModels, refresh, importModels, removeImported, findConfig, setSystemProxy, setTarget, inspectTargets, saveSettings, autoLocatePath, clearCache, sensenova, atomcode, probe, stopProbes, status, onResult = () => {}, onActivity }) {
  const active = new Set();
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Local proxy API key required', type: 'authentication_error' } });
    // 任何浏览器来源都不放行：WorkBuddy 通过它的原生运行时访问本服务。
    if (req.headers.origin) return json(res, 403, { error: { message: 'Browser-origin requests are disabled' } });
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    const controller = new AbortController(); active.add(controller);
    // 客户端断开要当成取消：继续跑下去只会浪费上游额度，还会把半途的结果当成完成。
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let heartbeat, model, started, streamStart, attempted = false, meta = {};
    try {
      if (req.method === 'GET' && route === '/health') return json(res, 200, status());
      if (req.method === 'GET' && route === '/v1/models') return json(res, 200, { object: 'list', data: getModels().map(m => ({ id: clientModelID(m), object: 'model', owned_by: 'opencode', name: clientModelID(m) })) });
      if (req.method === 'POST' && route === '/admin/probe') {        // 面板上的探测是用户明确要求重新验证的动作，所以忽略判定缓存（force）。
        const body = await readBody(req);
        return json(res, 202, probe(body.model, true, false, { force: true }));
      }
      // 「停止检测」：三线探测循环的统一中断开关，必须在探测进行中可调用。
      if (req.method === 'POST' && route === '/admin/probe-stop') return json(res, 200, stopProbes());
      if (req.method === 'POST' && route === '/admin/system-proxy') return json(res, 200, await setSystemProxy((await readBody(req)).enabled));
      if (req.method === 'POST' && route === '/admin/find-config') return json(res, 200, await findConfig());
      if (req.method === 'POST' && route === '/admin/selection') {
        const body = await readBody(req);
        return json(res, 200, await selectModel(body.model, body.selected));
      }
      if (req.method === 'POST' && route === '/admin/import') return json(res, 200, await importModels((await readBody(req)).modelsFile));
      // 移除配置 = 写入空集合：只摘掉本插件自己的条目，对文件里其它工具的配置原样保留。
      if (req.method === 'POST' && route === '/admin/remove') return json(res, 200, await removeImported());
      if (req.method === 'POST' && route === '/admin/inspect-targets') return json(res, 200, await inspectTargets());
      // 设置：面板发来的只是改动字段，合并与落盘都在服务侧做，主进程不碰配置文件。
      if (req.method === 'POST' && route === '/admin/settings') return json(res, 200, await saveSettings(await readBody(req)));
      if (req.method === 'POST' && route === '/admin/auto-locate-path') return json(res, 200, await autoLocatePath((await readBody(req)).target));
      if (req.method === 'POST' && route === '/admin/clear-cache') return json(res, 200, await clearCache());
      if (req.method === 'POST' && route === '/admin/target') return json(res, 200, await setTarget((await readBody(req)).target));
      if (req.method === 'POST' && route === '/admin/refresh') return json(res, 200, await refresh());
      // 日日新：密钥、接口地址、鉴权、逐模型探测、勾选、写入/移除。
      // 与 OpenCode 那套平行，但走的是直连上游的链路，不经过本机转发口。
      if (route.startsWith('/admin/sensenova/') && req.method === 'POST') {
        const action = route.slice('/admin/sensenova/'.length);
        const body = await readBody(req);
        if (action === 'save-key') return json(res, 200, await sensenova.saveKey(body.key));
        if (action === 'clear-key') return json(res, 200, await sensenova.clearKey());
        if (action === 'save-base') return json(res, 200, await sensenova.saveBase(body.apiBase));
        if (action === 'reset-base') return json(res, 200, await sensenova.resetBase());
        if (action === 'validate') return json(res, 200, await sensenova.validate());
        if (action === 'probe') return json(res, 200, await sensenova.probe(body.ids));
        if (action === 'selection') return json(res, 200, await sensenova.selection({ ids: body.ids }));
        if (action === 'import') return json(res, 200, await sensenova.import());
        if (action === 'remove') return json(res, 200, await sensenova.remove());
        return json(res, 404, { error: { message: 'Not found' } });
      }
      // AtomCode：安装 / 登录 / 目录刷新 / 网关 / 勾选 / 写入。它比日日新多两步本机动作。
      if (route.startsWith('/admin/atomcode/') && req.method === 'POST') {
        const action = route.slice('/admin/atomcode/'.length);
        const body = await readBody(req);
        if (action === 'detect') return json(res, 200, await atomcode.detect());
        if (action === 'install') return json(res, 200, await atomcode.install());
        if (action === 'login') return json(res, 200, await atomcode.login());
        if (action === 'refresh') return json(res, 200, await atomcode.refresh());
        if (action === 'probe') return json(res, 200, await atomcode.probe(body.ids));
        if (action === 'save-gateway') return json(res, 200, await atomcode['save-gateway'](body.gateway));
        if (action === 'reset-gateway') return json(res, 200, await atomcode['reset-gateway']());
        if (action === 'selection') return json(res, 200, await atomcode.selection({ ids: body.ids }));
        if (action === 'import') return json(res, 200, await atomcode.import());
        if (action === 'remove') return json(res, 200, await atomcode.remove());
        return json(res, 404, { error: { message: 'Not found' } });
      }
      if (req.method !== 'POST' || route !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Not found' } });
      if (active.size > 4) throw new BridgeError('At most four requests may run at once', 429, 'busy');
      const body = await readBody(req);
      model = body.model;
      const request = prepare(body, getModels());
      // 请求校验通过后，模型用的是上游 id（而不是客户端可见 id），下游全部按它记账。
      model = request.model.id;
      meta = { tools: request.tools.length, model: request.model.id, ...(onActivity ? { activity: onActivity } : {}) };
      // 接出方暂无契约：优先自定义头，退回 user-agent，再退 unknown（墨镜账本的 software 维度）。
      meta.software = String(req.headers['x-mobridge-client'] || req.headers['user-agent'] || 'unknown').slice(0, 120);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        // 先写一条注释行：客户端由此知道连接已经建立，而信封还在校验。
        res.write(': validating model response before emission\n\n');
        heartbeat = setInterval(() => res.write(': waiting\n\n'), 10000);
        // 上游真的开始出内容时就把 role 分片发出去，客户端不用等到整段回答完成才看到"开始了"。
        meta.activity = progress => {
          if (progress.content === true && !streamStart && !controller.signal.aborted && !res.destroyed && !res.writableEnded) {
            streamStart = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
            res.write(`data: ${JSON.stringify({ ...streamStart, object: 'chat.completion.chunk', model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          }
          onActivity?.(progress);
        };
      }
      attempted = true;
      started = performance.now();
      const result = await backend.complete(request, controller.signal, meta);
      // 被客户端取消的请求绝不能记成一次成功的调用。
      if (controller.signal.aborted) return;
      // 墨镜账本（T1.4）要 token 数：usage 挂在 meta 上随 onResult 下去（失败时本来就没有）。
      if (result && typeof result === 'object' && result.usage) meta.usage = result.usage;
      await onResult(model, true, undefined, undefined, undefined, Math.round(performance.now() - started), 'request', undefined, meta);
      result.model = body.model;
      if (body.stream) {
        if (streamStart) Object.assign(result, streamStart);
        sendSSE(res, result, body.stream_options?.include_usage, !!streamStart);
      }
      else json(res, 200, result);
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e.name === 'TimeoutError' ? 'Model request timed out' : e.message;
      if (attempted) await onResult(model || null, false, message, e.status, e.code, Math.round(performance.now() - started), 'request', undefined, meta);
      const error = { message, type: e.code || 'upstream_error', code: e.code || 'upstream_error' };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error })}\n\n`);
      else json(res, e.status || 502, { error });
    } finally { clearInterval(heartbeat); active.delete(controller); }
  });
  // 请求头 15 秒、整请求 20 秒：管理接口都是本地快操作，慢的只有推理，
  // 而推理那条路自己持有取消信号，不靠这个超时。
  server.requestTimeout = 20000; server.headersTimeout = 15000;
  server.abortAll = () => { for (const c of active) c.abort(); };
  return server;
}
