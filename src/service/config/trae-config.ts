import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// 不直接 import { createRequire }：build-service 的 banner 已经在 bundle 顶层
// 注入了同名绑定，再 import 一次会撞成 SyntaxError（打包成功但运行即炸）。
// 命名空间导入让 esbuild 自动改名，两条路（打包态 / strip-types 直跑）都安全。
import * as nodeModule from 'node:module';
const require_ = nodeModule.createRequire(import.meta.url);
import { spawn } from 'node:child_process';
import { SOURCE_OWNERS, OWNER_FIELD } from '../sync/sync.ts';
import { replaceWithRetry } from '../sync/atomic.ts';
// sql.js 是编译成 WASM 的真 SQLite：Electron 33 自带的 Node 20 没有 node:sqlite，
// 且 better-sqlite3 这类原生模块要跟 Electron ABI 对齐（B-02 打包 saga 的又一层坑）。
// 纯 WASM 没有原生绑定问题，dev（系统 Node）与打包态（Electron Node）行为一致。
import initSqlJs from 'sql.js';

// Trae（字节 VS Code fork）的自定义模型清单存在
// %APPDATA%/Trae CN/User/globalStorage/state.vscdb（SQLite KV，ItemTable）里：
//   key:   <userId>_AI.agent.model.model_list_map 和 <userId>:AI.agent.model.model_list_map
//   value: { <agent 模式>: [模型条目...] }，两种分隔符的键各存一份，都要写。
// 自定义模型条目形状来自 2026-11-18 本机实测样本（用户手动添加的日日新模型落盘原样）：
//   name/config_name = custom_openai_compatible//<上游模型名>（Trae 发请求时用 // 后面的真名）
//   base_url = 完整端点 URL，is_custom_base_url = true，config_source = 3，is_preset = false。
//
// 已知限制（后续调整项）：Trae 在 UI 里保存 Key 时会把 ak 字段加密（63 字节 AES-GCM，
// 密钥未知，不在凭据管理器/DB/任何能找到的文件里）。当前按用户拍板先写明文 Key：
// 条目结构与 Trae 原生落盘一致，仅 ak 一项是明文；若某版 Trae 强制解密会请求失败，
// 那时把 Key 换成在 Trae UI 里重新录入一次（结构仍由墨桥维护）。

const ICON = {
  dark: 'https://lf-cdn.trae.com.cn/obj/trae-com-cn/model/default-custom-dark.svg',
  light: 'https://lf-cdn.trae.com.cn/obj/trae-com-cn/model/default-custom-light.svg',
};

// FNV-1a 哈希取 10 位数字串：只求确定性派生，不追求密码学强度。
function fnv1a10(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(1000000000 + (hash % 9000000000));
}
// Trae 进程在内存里持有整份 model_list_map，退出/改设置时会整块回写——
// Trae 开着的时候改 DB，改动会被它无声覆盖。写入前必须确认进程已退出。
const TRAE_PROCESSES = ['Trae CN.exe', 'Trae.exe', 'Trae CN', 'Trae'];

export const MODEL_LIST_SUFFIX = 'AI.agent.model.model_list_map';

export function traeCandidates(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const { env = process.env, home = os.homedir(), savedFile } = options;
  if (savedFile?.trim()) return [path.resolve(savedFile.trim())];
  const configured = env.MOBRIDGE_TRAE_HOME?.trim();
  if (configured) return [path.join(path.resolve(configured), 'User', 'globalStorage', 'state.vscdb')];
  const appdata = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  // CN 版优先（用户的实际环境），国际版 Trae 兜底。
  return [
    path.join(appdata, 'Trae CN', 'User', 'globalStorage', 'state.vscdb'),
    path.join(appdata, 'Trae', 'User', 'globalStorage', 'state.vscdb'),
  ];
}

export async function resolveTraeState(options: Parameters<typeof traeCandidates>[0] = {}) {
  const candidates = traeCandidates(options);
  for (const file of candidates) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) return { file, exists: true, home: path.dirname(path.dirname(path.dirname(file))) };
  }
  return { file: candidates[0], exists: false, home: path.dirname(path.dirname(path.dirname(candidates[0]))) };
}

// ── 纯函数区（单测覆盖这里）───────────────────────────────────────────────

// 单个模型条目：逐字段照抄 Trae 原生落盘形状；缺的字段省略，
// 与样本里「未开启思考的模型」不带 reasoning 字段的行为一致。
export function traeModelEntry(model, baseUrl, key, { idOf = (m: { upstream: string }) => m.upstream, labelOf = (m: { id: string }) => m.id, owner } = {}) {
  const upstreamId = idOf(model);
  const name = `custom_openai_compatible//${upstreamId}`;
  const context = Number(model.context) > 0 ? Math.floor(Number(model.context)) : 200000;
  const levels = Array.isArray(model.levels) ? model.levels.filter(Boolean) : [];
  const entry: Record<string, unknown> = {
    name,
    multimodal: model.images === true,
    is_default: false,
    custom_config: '',
    display_name: labelOf(model),
    prompt_max_tokens: context,
    context_window_size: { max: [context], default: context },
    model_type: 'chat_model',
    builder: true,
    is_preset: false,
    client_connect: true,
    provider: 'custom_openai_compatible',
    icon: { ...ICON },
    ak: key,
    base_url: `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
    is_custom_base_url: true,
    status: true,
    // 样本里是 10 位数字串；用途是 Trae 内部的条目标识。
    // 从条目名确定性派生（FNV-1a 取 10 位数）：同一次写入重复执行时内容不变，
    // 「同内容不重复写」的幂等优化才成立；也避免随机数让每次轮末同步都重写整个 DB。
    custom_model_id: fnv1a10(name),
    config_source: 3,
    selectable: true,
    max_turns: { default: 500, max: 500 },
    auth_type: 0,
    features: { provider: { enabled: true, data: { provider_name: 'custom_openai_compatible' } } },
    max_tokens: 65536,
    max_turn: 500,
    custom_model_type: '',
    config_name: name,
    sk: '',
    use_remote_service: false,
    [OWNER_FIELD]: owner,
  };
  if (levels.length) {
    entry.thinking_enable = 1;
    entry.reasoning_param = { parameter: 'reasoning_effort', values: ['default', 'none', ...levels] };
    entry.reasoning_effort_config = { parameter: 'reasoning_effort', support_thinking: true, options: ['default', 'none', ...levels], default_level: 'default' };
  }
  return entry;
}

function isOwnedEntry(entry: unknown, owner: string) {
  return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)[OWNER_FIELD] === owner;
}

/**
 * 合并一份 model_list_map：每个 agent 模式的数组里先摘掉自己（这一路来源）的旧条目，
 * 再追加新清单。摘除只认传入的 owner——三路来源共写一份清单，
 * 日日新的移除绝不能把 OpenCode / AtomCode 写进去的条目一起带走。
 * Trae 自己添加自定义模型时会同步进多数模式的数组（实测 11/18 + 7/7），这里统一进全部
 * 模式数组——多出来的只是让该模型在更多场景可选，不改变既有条目。
 * 名字冲突让位给用户：同 name 的非自有条目已存在时跳过（宁可少一个不覆盖）。
 */
export function mergeTraeModelMap(map: Record<string, unknown>, models, baseUrl, key, { owner, idOf, labelOf } = {}) {
  const resolvedOwner = owner || SOURCE_OWNERS.opencode;
  const out: Record<string, unknown> = {};
  let touched = 0;
  for (const [mode, list] of Object.entries(map)) {
    if (!Array.isArray(list)) { out[mode] = list; continue; }
    const kept = list.filter(entry => !isOwnedEntry(entry, resolvedOwner));
    const names = new Set(kept.map(entry => String((entry as Record<string, unknown>)?.name || '')));
    const entries = models
      .map(model => traeModelEntry(model, baseUrl, key, { idOf, labelOf, owner: resolvedOwner }))
      .filter(entry => !names.has(entry.name));
    out[mode] = [...kept, ...entries];
    if (entries.length || kept.length !== list.length) touched += 1;
  }
  return { map: out, touched };
}

// 体检：数一份 model_list_map 里所有墨桥条目，按来源分家，ids 取写入名（display_name）。
export function inspectTraeModelMap(map: Record<string, unknown>) {
  const counts: Record<string, { count: number; ids: string[] }> = {};
  for (const source of Object.keys(SOURCE_OWNERS)) counts[source] = { count: 0, ids: [] };
  const seen = new Set<string>();
  let owned = 0;
  for (const list of Object.values(map)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const owner = (entry as Record<string, unknown>)?.[OWNER_FIELD];
      const hit = (Object.entries(SOURCE_OWNERS) as Array<[string, string]>).find(([, value]) => value === owner);
      if (!hit) continue;
      const id = String((entry as Record<string, unknown>)?.display_name || (entry as Record<string, unknown>)?.name || '');
      if (seen.has(id)) continue;
      seen.add(id);
      owned += 1;
      counts[hit[0]].count += 1;
      if (id) counts[hit[0]].ids.push(id);
    }
  }
  return { owned, sources: counts };
}

// ── SQLite I/O ────────────────────────────────────────────────────────────

let sqlPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

// wasm 探找顺序：打包态在 out/service（build-service 会复制）→ 开发态在 node_modules。
// 不能 resolve('sql.js/package.json')——它的 exports 没放行这个子路径，会直接抛
// ERR_PACKAGE_PATH_NOT_EXPORTED；从主入口（dist/sql-wasm.js）反推 dist 目录。
// 先 stat 确认文件真的存在再传给 emscripten：它对不存在的路径会直接 abort，
// 走不到我们预留的回退分支。
async function locateWasm(file: string): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, file)];
  try { candidates.push(path.join(path.dirname(require_.resolve('sql.js')), file)); } catch { /* 未安装时不炸，走到运行时再报 */ }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(stat => stat.isFile(), () => false)) return candidate;
  }
  return null;
}
async function loadSql() {
  sqlPromise ??= (async () => {
    const wasm = await locateWasm('sql-wasm.wasm');
    return initSqlJs(wasm ? { locateFile: () => wasm } : {});
  })();
  return sqlPromise;
}

function valueToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (value && typeof value === 'object' && 'length' in (value as { length: number }) && typeof (value as { length: number }).length === 'number')
    return Buffer.from(value as unknown as Uint8Array).toString('utf8');
  return String(value ?? '');
}

// 读出 state.vscdb 里的全部模型清单键：<uid>_AI.agent.model.model_list_map / <uid>:...
export async function readTraeModelMaps(file: string) {
  const SQL = await loadSql();
  const db = new SQL.Database(await fs.readFile(file));
  try {
    const rows = db.exec('SELECT key, value FROM ItemTable');
    const maps: Array<{ key: string; value: Record<string, unknown> }> = [];
    if (rows.length) {
      const columns = rows[0].columns;
      const keyIndex = columns.indexOf('key');
      const valueIndex = columns.indexOf('value');
      for (const row of rows[0].values) {
        const key = String(row[keyIndex] ?? '');
        if (!key.endsWith(MODEL_LIST_SUFFIX)) continue;
        try { maps.push({ key, value: JSON.parse(valueToText(row[valueIndex])) }); }
        catch { /* 这份键的值不是 JSON（版本差异）：跳过，另一份键通常还在 */ }
      }
    }
    return maps;
  } finally { db.close(); }
}

// Trae 是否在运行（Windows 用 tasklist；其它平台没有这个约束场景，直接放行）。
async function traeRunning(): Promise<string | null> {
  if (process.platform !== 'win32' || process.env.MOBRIDGE_ALLOW_RUNNING_CLIENTS === '1') return null;
  const output = await new Promise<string>(resolve => {
    const child = spawn('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    let text = '';
    child.stdout?.on('data', chunk => { text += String(chunk); });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });
  for (const name of TRAE_PROCESSES) {
    if (output.toLowerCase().includes(`"${name.toLowerCase()}"`)) return name;
  }
  return null;
}

function parseMapText(text: string, key: string) {
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Trae 的模型清单（${key}）不是可解析的 JSON，已跳过写入`); }
}

/**
 * 写 Trae 的模型清单。models 为空 = 收摊（只摘自己的条目）。
 * 安全规矩：Trae 在运行就拒绝（内存态会覆盖外部改动）；写前备份 DB、原子替换；
 * 两个键（`:` 与 `_` 分隔）都写，与 Trae 自己双写的行为一致。
 * DB 里一份键都没有且要写入时：说明 Trae 还没生成过模型清单（没打开过模型面板），
 * 明确报错而不是凭空造一份应用可能不认的键。
 */
export async function syncTraeModels(models, baseUrl, key, { file, owner, allowEmpty = true, idOf, labelOf } = {}) {
  const resolvedOwner = owner || SOURCE_OWNERS.opencode;
  const target = file || (await resolveTraeState()).file;
  const running = await traeRunning();
  if (running) throw new Error(`检测到 ${running} 正在运行：Trae 会用内存里的清单覆盖外部改动，请先完全退出 Trae 再写入`);
  if (!await fs.stat(target).catch(() => null)) {
    if (!models.length && allowEmpty) return { changed: false, count: 0, target: 'trae', file: target };
    throw new Error('未找到 Trae 的 state.vscdb；请先启动一次 Trae CN（%APPDATA%/Trae CN）');
  }
  const SQL = await loadSql();
  const raw = await fs.readFile(target);
  const db = new SQL.Database(raw);
  try {
    const rows = db.exec('SELECT key, value FROM ItemTable');
    const keyRows: Array<{ key: string; text: string }> = [];
    if (rows.length) {
      const keyIndex = rows[0].columns.indexOf('key');
      const valueIndex = rows[0].columns.indexOf('value');
      for (const row of rows[0].values) {
        const mapKey = String(row[keyIndex] ?? '');
        if (!mapKey.endsWith(MODEL_LIST_SUFFIX)) continue;
        keyRows.push({ key: mapKey, text: valueToText(row[valueIndex]) });
      }
    }
    if (!keyRows.length) {
      if (!models.length && allowEmpty) return { changed: false, count: 0, target: 'trae', file: target };
      throw new Error('state.vscdb 里还没有模型清单键；请先在 Trae 设置里打开一次「模型」面板再写入');
    }
    const changedKeys: Array<{ key: string; text: string }> = [];
    for (const row of keyRows) {
      const map = parseMapText(row.text, row.key);
      const { map: merged } = mergeTraeModelMap(map, models, baseUrl, key, { owner: resolvedOwner, idOf, labelOf });
      const text = JSON.stringify(merged);
      if (text !== row.text) changedKeys.push({ key: row.key, text });
    }
    if (!changedKeys.length) return { changed: false, count: models.length, target: 'trae', file: target };
    const fresh = await fs.readFile(target);
    if (Buffer.compare(raw, fresh) !== 0) throw new Error('Trae 数据库在写入过程中被修改，请重试');
    const backup = `${target}.mobridge-${Date.now()}.bak`;
    await fs.writeFile(backup, raw, { mode: 0o600, flag: 'wx' });
    await pruneTraeBackups(target);
    for (const row of changedKeys) db.run('UPDATE ItemTable SET value = ? WHERE key = ?', [row.text, row.key]);
    const bytes = db.export();
    const temp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(temp, Buffer.from(bytes), { mode: 0o600, flag: 'wx' });
    await replaceWithRetry(temp, target);
    return { changed: true, count: models.length, target: 'trae', file: target, backup, keys: changedKeys.map(entry => entry.key) };
  } finally { db.close(); }
}

export async function pruneTraeBackups(file: string, keep = 5) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.mobridge-`;
  try {
    const names = (await fs.readdir(directory)).filter(name => name.startsWith(prefix) && name.endsWith('.bak')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) await fs.unlink(path.join(directory, name)).catch(() => {});
  } catch { /* 目录不可读时跳过清理，不影响主流程 */ }
}

// 界面展示用：state.vscdb 在不在、里面有没有我们的条目、Trae 是否在运行。
export async function describeTrae(options: Parameters<typeof traeCandidates>[0] = {}) {
  const { file, exists, home } = await resolveTraeState(options);
  if (!exists) return { home, file, exists: false, running: await traeRunning() !== null, owned: 0, sources: null };
  try {
    const maps = await readTraeModelMaps(file);
    const totals = { owned: 0, sources: {} as Record<string, { count: number; ids: string[] }> };
    for (const source of Object.keys(SOURCE_OWNERS)) totals.sources[source] = { count: 0, ids: [] };
    for (const { value } of maps) {
      const info = inspectTraeModelMap(value);
      totals.owned = info.owned;
      for (const [source, slice] of Object.entries(info.sources)) {
        totals.sources[source].count = slice.count;
        totals.sources[source].ids = slice.ids;
      }
    }
    return { home, file, exists: true, running: await traeRunning() !== null, owned: totals.owned, sources: totals.sources };
  } catch {
    return { home, file, exists: true, running: await traeRunning() !== null, owned: 0, sources: null, error: '数据库无法解析' };
  }
}
