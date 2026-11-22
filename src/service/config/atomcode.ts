import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

// AtomCode（AtomGit CodingPlan）本机侧事实：装没装、登没登、网关在哪、勾了哪些。
//
// 它和日日新最大的不同：上游要注入一组 X-AtomCode-* 头 + Bearer token，
// 客户端自己做不到，所以这一路**必须**经过本机转发口（见 core/atomcode-bridge.ts）。
export const DEFAULT_GATEWAY = 'https://api-ai.gitcode.com';
export const DEFAULT_PLAN_API = 'https://api.gitcode.com/api/v5';
export const CLIENT_PREFIX = 'AC · ';
export const OFFICIAL_DOC = 'https://atomcode.atomgit.com/docs/zh/getting-started.html';
// 产品官网（已实测可达）；CodingPlan 的套餐管理页没有可独立确认的稳定地址，不提供链接。
export const OFFICIAL_SITE = 'https://atomcode.atomgit.com';

// 安装命令一律固定白名单，不拼接任何用户输入，也不用 curl|sh / irm|iex 这类管道脚本。
const INSTALL_COMMANDS = {
  win32: 'winget install -e --id AtomGit.AtomCode --accept-package-agreements --accept-source-agreements',
  darwin: 'brew install --cask atomcode',
  linux: 'npm install -g @atomgit.com/atomcode',
} as Record<string, string>;

export function installCommands(platform = process.platform) {
  return { command: INSTALL_COMMANDS[platform] ?? INSTALL_COMMANDS.linux, official: OFFICIAL_DOC };
}

export function atomcodeHome({ env = process.env, home = os.homedir() } = {}) {
  const configured = env.ATOMCODE_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(home, '.atomcode');
}
export function authFile(home = atomcodeHome()) { return path.join(home, 'auth.toml'); }
export function configFile(home = atomcodeHome()) { return path.join(home, 'config.toml'); }

function binaryCandidates({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const list = [env.MOBRIDGE_ATOMCODE_PATH, env.ATOMCODE_PATH];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(path.join(local, 'AtomCode', 'atomcode.exe'));
    list.push(path.join(roaming, 'npm', 'atomcode.cmd'));
  } else {
    list.push(path.join(home, '.local', 'bin', 'atomcode'), '/opt/homebrew/bin/atomcode', '/usr/local/bin/atomcode');
  }
  return [...new Set(list.filter(Boolean) as string[])];
}

/**
 * AtomCode CLI 是 node 程序：系统 PATH 里若是老 node（如 14），--version/login/daemon
 * 都会启动极慢甚至直接失败（用户实测）。WorkBuddy 自带 node 22
 * （~/.workbuddy/binaries/node/versions/<v>/），找到就把它的目录前置到 PATH——
 * CLI 子进程继承这个 env，自动用上 node 22；没有就原样用系统环境。
 */
export function preferredNodeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  try {
    const root = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
    const dir = fsSync.readdirSync(root)
      .filter(name => /^22\./.test(name))
      .sort()
      .reverse()[0];
    if (dir) return { ...base, PATH: path.join(root, dir) + path.delimiter + (base.PATH ?? '') };
  } catch { /* 没有 WorkBuddy 自带 node 就用系统的 */ }
  return base;
}

function run(file: string, args: string[], timeoutMs: number) {
  return new Promise<{ ok: boolean, code: number | null, output: string }>(resolve => {
    let output = '', settled = false;
    const finish = (ok: boolean, code: number | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, code, output: (output + (extra ? '\n' + extra : '')).slice(-8000) });
    };
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: preferredNodeEnv() }); }
    catch (error) { resolve({ ok: false, code: null, output: (error as Error).message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } finish(false, null, '命令超时，已中止'); }, timeoutMs);
    child.stdout?.on('data', chunk => { output += chunk.toString(); });
    child.stderr?.on('data', chunk => { output += chunk.toString(); });
    child.on('error', error => finish(false, null, error.message));
    child.on('close', code => finish(code === 0, code));
  });
}

/**
 * 从 `atomcode --version` 的输出里挑出版本号。
 * Windows 上它会先把代码页警告打到 stderr（`Console code pages: input 936 …`），
 * 而 run() 把 stdout 和 stderr 合并在一起，直接取第一行就会把警告当成版本号显示给用户。
 * 真身长这样：`atomcode 5.2.6 (25df55d8)` —— 取版本号本身，页面自己会拼「AtomCode x.y.z」。
 */
export function pickVersion(output: string) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || /code page|chcp|garbled|Windows Terminal/i.test(text)) continue;
    const match = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
    if (match) return match[1];
  }
  return null;
}

/** 探测本机是否已安装 AtomCode：先试 PATH 上的名字，再试各安装位置。 */
export async function detectAtomcode(options: Parameters<typeof binaryCandidates>[0] = {}) {
  const direct = process.platform === 'win32' ? 'atomcode.exe' : 'atomcode';
  for (const file of [direct, ...binaryCandidates(options)]) {
    const result = await run(file, ['--version'], 15000);
    // 能跑起来就算装上：版本号可选，认不出来也不能因此把「已安装」判成「未安装」。
    if (result.ok && result.output.trim()) return { installed: true, path: file, version: pickVersion(result.output) };
  }
  return { installed: false, path: null, version: null };
}

/** 装 AtomCode。命令来自白名单，安装过程本身由包管理器负责。 */
export async function runInstall(platform = process.platform) {
  const shell = platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = platform === 'win32' ? ['/d', '/c', installCommands(platform).command] : ['-c', installCommands(platform).command];
  return run(shell, args, 300000);
}

/** 无头直跑 `atomcode login`。没有 TTY 时 CLI 会拒绝进交互模式——现在只作弹窗失败后的兜底。 */
export async function runLogin(binary: string | null) {
  if (!binary) return { ok: false, code: null, output: '未找到 atomcode，请先安装' };
  return run(binary, ['login'], 180000);
}

/**
 * 弹一个可见终端窗口跑 `atomcode login`：命令作为启动参数随窗口执行，不做按键模拟。
 * 优先 Windows Terminal（WindowsApps 里的应用执行别名），没有就退回 `cmd /c start`；
 * /k 让窗口执行完不关闭，用户能看到 CLI 的输出和报错。
 * spawn 用 verbatim 参数：cmd 的引号规则和 Node 默认转义不一致，自己拼好引号反而可控。
 * 窗口进程 detached + stdio ignore，独立于墨桥存活；terminal 字段让调用方知道走了哪条路。
 */
export async function openLoginTerminal(binary: string, { home = os.homedir(), platform = process.platform } = {}) {
  if (platform !== 'win32') return { ok: false, terminal: null as string | null, error: '当前系统不支持弹出终端，回退后台执行' };
  const env = preferredNodeEnv();
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const commandLine = `"${binary}" login`;
  const attempts: Array<{ terminal: string, file: string, args: string[] }> = [];
  const wt = path.join(local, 'Microsoft', 'WindowsApps', 'wt.exe');
  if (fsSync.existsSync(wt)) attempts.push({ terminal: 'Windows Terminal', file: wt, args: ['cmd', '/k', commandLine] });
  attempts.push({ terminal: 'cmd', file: 'cmd.exe', args: ['/c', 'start', '"AtomCode 登录"', 'cmd', '/k', commandLine] });
  for (const attempt of attempts) {
    const spawned = await new Promise<boolean>(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(attempt.file, attempt.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env });
      } catch { resolve(false); return; }
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    });
    if (spawned) return { ok: true, terminal: attempt.terminal, error: null as string | null };
  }
  return { ok: false, terminal: null as string | null, error: '没能弹出终端窗口，回退后台执行' };
}

// auth.toml 只有顶层标量，够拿到登录态；不做通用 TOML 解析。
export function parseTomlScalars(text: string) {
  const out: Record<string, string | number | boolean> = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
    else if (value === 'true' || value === 'false') value = value === 'true';
    out[match[1]] = value;
  }
  return out;
}

export async function readAuth(home = atomcodeHome()) {
  const file = authFile(home);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) return { file, present: false, values: {} as Record<string, string | number | boolean>, mtimeMs: null as number | null, error: null as string | null };
  try {
    return { file, present: true, values: parseTomlScalars(await fs.readFile(file, 'utf8')), mtimeMs: stat.mtimeMs, error: null };
  } catch (error) {
    return { file, present: true, values: {} as Record<string, string | number | boolean>, mtimeMs: stat.mtimeMs, error: (error as Error).message };
  }
}

export function maskEmail(email: unknown) {
  if (typeof email !== 'string' || !email.includes('@')) return '—';
  const [name, domain] = email.split('@');
  return (name.slice(0, 1) || '?') + '***@' + domain;
}

/** 登录态摘要：token 本身永不出主进程，只给账号与到期时间。 */
export function accountInfo(values: Record<string, unknown>, fallbackMs?: number | null) {
  const token = typeof values.access_token === 'string' ? values.access_token : null;
  const expiresIn = Number(values.expires_in);
  let expiresAt: string | null = null;
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    let base = Number.NaN;
    const created = values.created_at;
    const numeric = Number(created);
    if (Number.isFinite(numeric) && numeric > 0) base = numeric < 1e12 ? numeric * 1000 : numeric;
    else if (typeof created === 'string' && !Number.isNaN(Date.parse(created))) base = Date.parse(created);
    else if (Number.isFinite(fallbackMs ?? NaN)) base = fallbackMs as number;
    if (Number.isFinite(base)) expiresAt = new Date(base + expiresIn * 1000).toISOString();
  }
  return {
    username: (values.username as string) || (values.name as string) || '—',
    email: maskEmail(values.email),
    expiresAt,
    tokenPresent: !!token,
  };
}

// 可编辑网关：落盘到墨桥数据目录，写入时用它替代官方默认地址。
export function gatewayFile(dataDir: string) { return path.join(dataDir, 'atomcode.json'); }
export async function readGateway(dataDir: string) {
  const text = await fs.readFile(gatewayFile(dataDir), 'utf8').catch(() => null);
  if (text) {
    try {
      const saved = JSON.parse(text) as { gateway?: string };
      if (typeof saved.gateway === 'string' && saved.gateway.trim()) return { gateway: normalizeGateway(saved.gateway), custom: true };
    } catch { /* 坏文件按默认走 */ }
  }
  return { gateway: normalizeGateway(process.env.MOBRIDGE_ATOMCODE_GATEWAY || DEFAULT_GATEWAY), custom: false };
}
export async function saveGateway(dataDir: string, value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    await fs.unlink(gatewayFile(dataDir)).catch(() => {});
    return { gateway: normalizeGateway(DEFAULT_GATEWAY), custom: false };
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('网关地址不是合法 URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('网关地址必须是 http(s)');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(gatewayFile(dataDir), JSON.stringify({ gateway: normalizeGateway(raw) }) + '\n', { mode: 0o600 });
  return { gateway: normalizeGateway(raw), custom: true };
}
export function normalizeGateway(value: string) { return String(value || DEFAULT_GATEWAY).trim().replace(/\/+$/, ''); }

/** 上游网关请求头：当前网关只校验这些头存在，不校验签名值。 */
export function gatewayHeaders(token: string) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'X-AtomCode-Sig': 'atomcode-open-api',
    'X-AtomCode-Ts': String(Math.floor(Date.now() / 1000)),
    'X-AtomCode-Nonce': Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2),
    'X-AtomCode-Alg': 'atomcode-signing-v1',
    'X-AtomCode-Ver': 'v1',
  };
}

// ── 勾选记录 ────────────────────────────────────────────────────────────
export function selectionFile(dataDir: string) { return path.join(dataDir, 'atomcode-selection.json'); }
export async function readSelection(dataDir: string): Promise<string[] | null> {
  const text = await fs.readFile(selectionFile(dataDir), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch { return null; }
}
export async function saveSelection(dataDir: string, ids: unknown) {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(selectionFile(dataDir), JSON.stringify(list) + '\n', { mode: 0o600 });
  return list;
}
