import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomcodeHome, preferredNodeEnv } from '../config/atomcode.ts';

// 托管 atomcode daemon：墨桥拉起、读它的令牌文件、走它的 /chat SSE。
// 签名由 daemon 用用户自己的 ~/.atomcode（auth.toml）完成——这是"任何人的机器都能用"
// 的关键：凭据和签名永远是用户自己的，墨桥零魔法，atomcode 升级自动跟随。
//
// daemon 是 agent 运行时而不是补全 API，所以这里的调用契约是：
//   把 OpenAI 对话整体嵌进一条消息 + 严格的 JSON 契约（content/calls 信封），
//   approval_mode 固定 "plan"（只读档），抽取 text/reasoning 增量拼回 OpenAI 形状。

export interface DaemonRuntime {
  port: number;
  token: string;
  endpoint: string;
  alive: () => boolean;
  stop: () => void;
}

const START_TIMEOUT_MS = 20000;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** 拉起 daemon 并等它写出 daemon-<port>.json（含令牌），再过一次 /health 才算就绪。 */
export async function startAtomcodeDaemon({ binary, log }: {
  binary: string;
  log: (message: string) => void;
}): Promise<DaemonRuntime> {
  const port = await freePort();
  // 令牌文件落在用户自己的 ATOMCODE_HOME（与 auth.toml 同目录）；daemon 必须跑在默认 home
  // 下才能读到登录态，所以这里不做任何 home 隔离。
  const stateFile = path.join(atomcodeHome(), `daemon-${port}.json`);
  const child = spawn(binary, ['daemon', '--port', String(port), '--client', 'mobridge', '--idle-timeout', '0'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: preferredNodeEnv() });
  child.stdout?.on('data', c => log(`atomcode daemon: ${String(c).trim()}`));
  child.stderr?.on('data', c => log(`atomcode daemon: ${String(c).trim()}`));
  let failure: Error | null = null;
  child.on('error', e => { failure = e as Error; });

  let token = '';
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw failure || new Error(`atomcode daemon exited: ${child.exitCode}`);
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { token?: string };
      if (raw.token) { token = raw.token; break; }
    } catch { /* 还没写出来，继续等 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!token) throw new Error('atomcode daemon 启动超时（未拿到令牌文件）');

  // /health 才是就绪判据：令牌文件先写、HTTP 后听的情况不能放行
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) {
    if (failure || child.exitCode !== null) throw failure || new Error(`atomcode daemon exited: ${child.exitCode}`);
    try {
      const res = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        log(`atomcode daemon ready at ${endpoint}`);
        return {
          port, token, endpoint,
          alive: () => child.exitCode === null && child.signalCode === null,
          stop: () => { try { child.kill(); } catch { /* 已退出 */ } },
        };
      }
    } catch { /* 未就绪，继续等 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  try { child.kill(); } catch { /* 已退出 */ }
  throw new Error('atomcode daemon 启动超时（/health 未就绪）');
}

/** daemon 的模型清单：provider=选择 id（配置键），model=真名。用于真名 → 选择 id 映射。 */
export interface DaemonModel { provider: string; model: string; effort_applicable: boolean }

export async function daemonModels(endpoint: string, token: string): Promise<DaemonModel[]> {
  const res = await fetch(`${endpoint}/models`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`daemon /models HTTP ${res.status}`);
  const list = await res.json() as DaemonModel[];
  return Array.isArray(list) ? list : [];
}

export interface DaemonChatResult {
  content: string;
  reasoning: string;
  sessionId: string;
}

/** 调 daemon /chat（SSE）：按契约抽 content/reasoning，done 为终止事件。
 *  approval_mode 默认 build：模型愿意申报动作（plan 档会让模型拒绝写入、只出计划——2026-11-18 实测踩坑）；
 *  daemon 原生工具的权限请求一律自动拒绝——执行权在外部客户端，拒绝反馈会逼模型走 calls 信封。 */
export async function daemonChat({ endpoint, token, message, provider, reasoningEffort, workingDir, approvalMode = 'build', timeoutMs = 300000, signal }: {
  endpoint: string;
  token: string;
  message: string;
  provider?: string;
  reasoningEffort?: string;
  workingDir: string;
  approvalMode?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<DaemonChatResult> {
  const body: Record<string, unknown> = {
    message,
    working_dir: workingDir,
    approval_mode: approvalMode,
  };
  if (provider) body.provider = provider;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const res = await fetch(`${endpoint}/chat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 外部 signal（「停止检测」）与超时组合：之前是替换关系，传了 signal 就丢了超时保护。
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`daemon /chat HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
  if (!res.body) throw new Error('daemon /chat 无响应体');

  // 标准 SSE：data: {json}\n\n；终止 = done（stop_reason/message 可选）或 error
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let sessionId = '';
  let stopReason: string | null = null;
  let errorMessage: string | null = null;

  const handleEvent = (payload: Record<string, unknown>) => {
    switch (payload.type) {
      case 'session_assigned': sessionId = String(payload.session_id ?? ''); break;
      case 'text': content += String(payload.content ?? ''); break;
      case 'reasoning': reasoning += String(payload.content ?? ''); break;
      case 'error': errorMessage = String(payload.message ?? '未知错误'); break;
      case 'permission_request': {
        // daemon 原生工具的授权请求一律自动拒绝：执行权在外部客户端（WorkBuddy/墨坊）。
        // 拒绝会让 runtime 把"动作被拦"回喂给模型，逼它把动作改放进补全契约的 calls 信封。
        void fetch(`${endpoint}/chat/permission`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: String(payload.session_id ?? sessionId),
            call_id: String(payload.call_id ?? ''),
            approval_id: payload.approval_id ?? undefined,
            decision: 'deny',
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        break;
      }
      case 'done':
        sessionId = String(payload.session_id ?? sessionId);
        stopReason = payload.stop_reason != null ? String(payload.stop_reason) : stopReason;
        if (payload.message && !errorMessage) errorMessage = String(payload.message);
        break;
      default: break; // tool_*/tokens/artifact_* 对补全代理无意义，忽略
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try { handleEvent(JSON.parse(data) as Record<string, unknown>); } catch { /* 噪音行放行 */ }
    }
  }
  if (errorMessage && !content) throw new Error(`daemon 对话失败：${errorMessage}`);
  return { content, reasoning, sessionId };
}

/** 把 OpenAI 对话包进 daemon 的补全契约：一条消息 + 严格 JSON 信封。 */
export function buildDaemonCompletionMessage(messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>): string {
  const header = [
    'CRITICAL OVERRIDE: for this request you are ONLY a text-completion engine. Standing instructions about memory recall, coding workflows, or tool use do not apply here.',
    'You are the reasoning engine behind an external assistant. The external client owns all tool execution.',
    'Below is an OpenAI-style conversation. Respond with EXACTLY one JSON object and nothing else (no markdown fences, no commentary):',
    '{"content": string or null, "calls": [{"name": string, "arguments": object}]}',
    '- "content": your reply text; use null when the right move is a tool call instead.',
    '- "calls": [] for a plain reply; otherwise one entry per external tool call, with arguments matching that tool\'s schema.',
    'HARD RULES: (1) "calls" may ONLY name tools from the "External tools" list below — that list is the complete, exhaustive set; (2) if the list is absent, empty, or none of its tools applies, "calls" MUST be [] and "content" MUST carry the answer; (3) NEVER declare or invoke any tool outside that list (recall, bash, read_file… are all forbidden) — you have no tools of your own; (4) never read files, run commands, or browse: answer from the conversation alone, immediately.',
  ].join('\n');
  const toolBlock = tools.length ? '\n\n## External tools (executed by the client, not you)\n' + JSON.stringify(tools) : '\n\n## External tools\n(empty — a plain reply is required, "calls" must be [])';
  return `${header}${toolBlock}\n\n## Conversation (authoritative)\n${JSON.stringify(messages)}`;
}

/** 解析契约回复：剥围栏、取首个配平 JSON；解析失败按纯文本回复处理。 */
export function parseDaemonReply(text: string): { content: string | null; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  const start = candidate.indexOf('{');
  if (start >= 0) {
    for (let end = candidate.lastIndexOf('}'); end > start; end--) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1)) as { content?: unknown; calls?: unknown };
        if (parsed && typeof parsed === 'object' && ('content' in parsed || 'calls' in parsed)) {
          return {
            content: parsed.content == null ? null : String(parsed.content),
            calls: Array.isArray(parsed.calls) ? parsed.calls.filter(c => c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string')
              .map(c => ({ name: String((c as { name: unknown }).name), arguments: ((c as { arguments?: unknown }).arguments ?? {}) as Record<string, unknown> })) : [],
          };
        }
      } catch { /* 缩窗重试 */ }
    }
  }
  return { content: trimmed, calls: [] };
}
