import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SOURCE_OWNERS, OWNER_FIELD, atomicWrite, pruneBackups } from '../sync/sync.ts';

// Qoder（阿里 Agentic 工作台，含 Qoder CN 桌面端）的 BYOK 自定义模型存在
// ~/.qoder-cn/settings.json（国际版在 ~/.qoder/settings.json）的 providers 键下：
//   "qoder-custom-<uuid>": { baseUrl, apiKey, type, protocol, authType, model, models[], displayName }
// 这里的写入形态：每个接入来源（opencode / atomcode / sensenova）维护一条 provider，
// 只增删带 mobridgeOwner 标记的那几条，用户自己加的 qoder-custom-* 一律原样保留。
//
// 格式来源：2026-11-18 本机实测样本（用户手动添加的日日新自定义模型落盘原样）。
// Key 是明文 JSON 字段，Qoder 读文件时直接使用——无需解密环节。

// 我们的 provider 键有固定前缀，配合条目内的 owner 标记双重识别：
// 键前缀让人在 Qoder 设置列表里也能一眼认出「这是墨桥写的」。
export function providerKeyOf(source: keyof typeof SOURCE_OWNERS) {
  return `qoder-custom-mobridge-${source}`;
}
const PROVIDER_KEY_PREFIX = 'qoder-custom-mobridge-';

// 数据目录规则：CN 版与桌面国际版都可能装，优先 settings.json 已存在的那份；
// 两个都不存在时回落 CN 版路径（用户的实际环境就是 CN 版，报错信息也对准它）。
export function qoderCandidates(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const { env = process.env, home = os.homedir(), savedFile } = options;
  if (savedFile?.trim()) return [path.resolve(savedFile.trim())];
  const configured = env.MOBRIDGE_QODER_HOME?.trim();
  if (configured) return [path.join(path.resolve(configured), 'settings.json')];
  return [path.join(home, '.qoder-cn', 'settings.json'), path.join(home, '.qoder', 'settings.json')];
}

export async function resolveQoderConfig(options: Parameters<typeof qoderCandidates>[0] = {}) {
  const candidates = qoderCandidates(options);
  for (const file of candidates) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) return { file, exists: true, home: path.dirname(file) };
  }
  return { file: candidates[0], exists: false, home: path.dirname(candidates[0]) };
}

// settings.json 可能带 UTF-8 BOM；解析失败直接报人话，绝不静默跳过。
function parseSettings(text: string) {
  const doc = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Qoder settings.json 不是对象结构');
  return doc as Record<string, unknown>;
}

function providerListOf(document: Record<string, unknown>) {
  const providers = document.providers;
  if (providers === undefined) return {} as Record<string, Record<string, unknown>>;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers))
    throw new Error('Qoder settings.json 的 providers 不是对象结构');
  return providers as Record<string, Record<string, unknown>>;
}

function isOwnedProvider(entry: unknown, owner: string) {
  return !!entry && typeof entry === 'object' && (entry as Record<string, unknown>)[OWNER_FIELD] === owner;
}
function isMobridgeProviderKey(key: string) {
  return key.startsWith(PROVIDER_KEY_PREFIX);
}

// 单个模型能力条目：字段照抄 Qoder 自己落盘的形状。
// thinking 缺省时写空能力（跟 Qoder 为「不支持思考的模型」落盘的形状一致），不要省键。
export function qoderModelEntry(model, { idOf = (m: { upstream: string }) => m.upstream, labelOf = (m: { id: string }) => m.id } = {}) {
  const entry: Record<string, unknown> = {
    model: idOf(model),
    displayName: labelOf(model),
    maxOutputTokens: 8192,
    capabilities: { vision: model.images === true, thinking: { modes: [], supportsEffort: false, supportedEffortLevels: [] } },
  };
  if (Number(model.context) > 0) entry.contextWindow = Number(model.context);
  const levels = Array.isArray(model.levels) ? model.levels.filter(Boolean) : [];
  if (levels.length) {
    entry.capabilities = {
      vision: model.images === true,
      thinking: { modes: ['enabled'], supportsEffort: true, supportedEffortLevels: levels.slice() },
    };
  }
  return entry;
}

// 一条完整的自定义 provider。endpoint 是 Base URL（不带 /chat/completions，
// Qoder 自己拼路径——官方示例格式就是 https://api.example.com/v1）。
export function qoderProvider(models, baseUrl, key, { source, owner, idOf, labelOf } = {}) {
  const resolvedSource = (source as keyof typeof SOURCE_OWNERS) || 'opencode';
  const resolvedOwner = owner || SOURCE_OWNERS[resolvedSource];
  const list = models.map(model => qoderModelEntry(model, { idOf, labelOf }));
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    apiKey: key,
    type: 'openai-compatible',
    protocol: 'openai',
    authType: 'bearer',
    model: list[0]?.model ?? '',
    models: list,
    displayName: '墨桥 MoBridge',
    [OWNER_FIELD]: resolvedOwner,
  };
}

// 合并：先摘掉自己（这一路来源）的旧 provider，再按键追加。
// 摘除只认条目内的 owner 标记——三路来源共写一份 providers 对象
// （键前缀 qoder-custom-mobridge-<source> 不同），任何一路的写入/移除
// 都绝不能碰另外两路的条目（手册 D-01 的教训：owner 不分家会互相擦除）。
// 键冲突（用户恰好用了 qoder-custom-mobridge-xxx 这个键名）让位给用户，不覆盖。
export function mergeQoderProviders(document: Record<string, unknown>, provider: Record<string, unknown> | null, { providerKey, owner }: { providerKey: string; owner: string }) {
  const providers = providerListOf(document);
  const kept: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(providers)) {
    if (isOwnedProvider(entry, owner)) continue;
    kept[key] = entry;
  }
  if (provider === null) return { ...document, providers: kept };
  if (kept[providerKey] !== undefined) {
    const error = new Error(`Qoder 设置里已存在用户自建的 ${providerKey}，为避免覆盖已跳过写入`);
    (error as Error & { code?: string }).code = 'QODER_ID_CONFLICT';
    throw error;
  }
  kept[providerKey] = provider;
  return { ...document, providers: kept };
}

// 体检：数出这个文件里所有墨桥条目，按来源分家。
// 识别以条目内的 mobridgeOwner 为准（键前缀只用于写入时自查，防的是用户手工改动）。
// count 口径是「模型条数」（每路来源一条 provider，provider 里挂 N 个模型），
// 与 Trae / WorkBuddy 的「写了几个模型」对齐；owned 也是模型总数。
export function inspectQoderProviders(document: Record<string, unknown>) {
  const providers = providerListOf(document);
  const counts: Record<string, { count: number; ids: string[] }> = {};
  for (const source of Object.keys(SOURCE_OWNERS)) counts[source] = { count: 0, ids: [] };
  let owned = 0;
  for (const [key, entry] of Object.entries(providers)) {
    const owner = (entry as Record<string, unknown>)?.[OWNER_FIELD];
    const hit = (Object.entries(SOURCE_OWNERS) as Array<[string, string]>).find(([, value]) => value === owner);
    if (!hit) continue;
    const models = Array.isArray((entry as Record<string, unknown>)?.models) ? (entry as { models: unknown[] }).models : [];
    owned += models.length;
    counts[hit[0]].count += models.length;
    counts[hit[0]].ids.push(models.length ? `${key}（${models.length} 个模型）` : key);
  }
  return { owned, sources: counts };
}

// 写入 Qoder 设置。models 为空 = 收摊，只摘这一路来源的 provider。
// 规矩与墨坊一致：内容相同不写、写前备份、原子替换、写前再读一次防并发覆盖。
export async function syncQoderProviders(models, baseUrl, key, { file, source = 'opencode', owner, allowEmpty = false, idOf, labelOf } = {}) {
  const resolvedSource = source as keyof typeof SOURCE_OWNERS;
  const resolvedOwner = owner || SOURCE_OWNERS[resolvedSource];
  const target = file || (await resolveQoderConfig()).file;
  const old = await fs.readFile(target, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (old === null) {
    if (!models.length && allowEmpty) return { changed: false, count: 0, target: 'qoder', file: target };
    throw new Error('未找到 Qoder 的 settings.json；请先启动一次 Qoder（~/.qoder-cn/settings.json）');
  }
  if (!models.length && !allowEmpty) throw new Error('模型清单为空，已保留 Qoder 现有配置');
  let document: Record<string, unknown>;
  try { document = parseSettings(old); }
  catch { throw new Error('Qoder settings.json 不是可解析的 JSON，已跳过写入'); }
  const provider = models.length ? qoderProvider(models, baseUrl, key, { source: resolvedSource, owner: resolvedOwner, idOf, labelOf }) : null;
  let merged: Record<string, unknown>;
  try { merged = mergeQoderProviders(document, provider, { providerKey: providerKeyOf(resolvedSource), owner: resolvedOwner }); }
  catch (error) {
    if ((error as Error & { code?: string }).code === 'QODER_ID_CONFLICT') return { changed: false, count: 0, target: 'qoder', file: target, conflict: true, message: (error as Error).message };
    throw error;
  }
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (text === old) return { changed: false, count: models.length, target: 'qoder', file: target };
  const current = await fs.readFile(target, 'utf8').catch(() => null);
  if (current !== old) throw new Error('Qoder settings.json 在写入过程中被修改，请重试');
  const backup = `${target}.mobridge-${Date.now()}.bak`;
  await fs.writeFile(backup, old, { mode: 0o600, flag: 'wx' });
  await pruneBackups(target);
  await atomicWrite(target, text);
  return { changed: true, count: models.length, target: 'qoder', file: target, backup };
}

// 界面展示用：这个目标写到哪、里面有哪些不属于我们的 provider 键。
// sources 一并带出（按来源分家的条目数与键名清单），体检与页面直接取用。
export async function describeQoder(options: Parameters<typeof qoderCandidates>[0] = {}) {
  const { file, exists, home } = await resolveQoderConfig(options);
  if (!exists) return { home, file, exists: false, providers: [] as string[], userProviders: [] as string[], ownedModels: 0, sources: null };
  try {
    const document = parseSettings(await fs.readFile(file, 'utf8'));
    const info = inspectQoderProviders(document);
    const providerKeys = Object.keys(providerListOf(document));
    return {
      home, file, exists: true,
      providers: providerKeys.filter(key => isMobridgeProviderKey(key)),
      userProviders: providerKeys.filter(key => !isMobridgeProviderKey(key)),
      ownedModels: info.owned,
      sources: info.sources,
    };
  } catch {
    return { home, file, exists: true, providers: [] as string[], userProviders: [] as string[], ownedModels: 0, sources: null, error: '配置无法解析' };
  }
}
