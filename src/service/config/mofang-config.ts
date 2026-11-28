import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite, pruneBackups, OWNER, OWNER_FIELD } from '../sync/sync.ts';

// 墨坊（jzWorkBuddy / ai-coding-tool-ts）侧没有「一整份模型清单」的文件：
// 模型来源是 config.json 里的 providers 数组，每个 provider 自带 baseURL / apiKey / models。
// 所以这里的写入形态是「在数组里维护一条属于本产品的 provider」：
//   - 只增删带 owner 标记的那一条，用户自己写的 provider 一律原样保留；
//   - 绝不擅自改 activeProvider（那是用户当前用哪家的选择，不属于我们该动的范围）。
export const PROVIDER_ID = 'mobridge';
const PROVIDER_NAME = '墨桥 · OpenCode';
const PROVIDER_DESCRIPTION = '墨桥本机转发（127.0.0.1）；关闭墨桥后此 provider 不可用。';

// 墨坊自己的数据目录规则：新的 ~/.mofang 优先，新目录不存在而旧的 ~/.ai-coding-tool
// 存在时继续沿用旧目录（老用户不丢会话与设置）。这里必须和它保持同一套判断，
// 否则我们会把 provider 写进一个应用根本不读的目录里。
export function locateMofangHome(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const { env = process.env, home = os.homedir(), savedFile } = options;
  if (savedFile?.trim()) return path.dirname(path.resolve(savedFile.trim()));
  const configured = env.MOFANG_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(home, '.mofang');
}

export function mofangCandidates(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const { env = process.env, home = os.homedir(), savedFile } = options;
  // 用户在设置里直接选的是 config.json 文件，优先且不再回落到其它目录。
  if (savedFile?.trim()) return [path.resolve(savedFile.trim())];
  const configured = env.MOFANG_HOME?.trim();
  if (configured) return [path.join(path.resolve(configured), 'config.json')];
  return [path.join(home, '.mofang', 'config.json'), path.join(home, '.ai-coding-tool', 'config.json')];
}

// 返回真正存在的配置文件；两个都不存在时返回首选路径（供 UI 说明「还没生成」）。
export async function resolveMofangConfig(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const candidates = mofangCandidates(options);
  for (const file of candidates) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) return { file, exists: true, home: path.dirname(file) };
  }
  return { file: candidates[0], exists: false, home: path.dirname(candidates[0]) };
}

// 墨坊的 config.json 可能带 UTF-8 BOM（Windows 记事本另存就会带上），直接 JSON.parse 会炸。
function parseConfig(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''));
}

function isOwned(entry, owner = OWNER) {
  return !!entry && typeof entry === 'object' && entry[OWNER_FIELD] === owner;
}

// 单个模型条目：基础字段照抄墨坊自己写出来的条目（id / name / isVision）。
// contextWindow / reasoningEfforts 是墨坊 v2 起认识的扩展字段：目录里有就带上，
// 墨坊设置页展示"上下文窗口 / 思考强度"，调用时把选中的档位映射成 reasoning_effort。
// 旧版墨坊不认识这两个键只会忽略，写入永远向后兼容。
export function mofangModelEntry(model, { idOf = m => m.id, labelOf = m => m.name || m.id } = {}) {
  const entry = {
    id: idOf(model),
    name: labelOf(model),
    isVision: model.images === true,
  };
  if (Number(model.context) > 0) entry.contextWindow = Number(model.context);
  if (Array.isArray(model.levels) && model.levels.length) entry.reasoningEfforts = model.levels.slice();
  return entry;
}

export function mofangProvider(models, endpoint, key, { providerId = PROVIDER_ID, owner = OWNER, name = PROVIDER_NAME, idOf, labelOf } = {}) {
  return {
    id: providerId,
    name,
    baseURL: endpoint.replace(/\/+$/, ''),
    // 本机转发口要 Bearer 口令；口令只存在我们自己维护的这条 provider 里，
    // 不碰用户已有的任何 provider 的 apiKey。
    apiKey: key,
    model: idOf ? idOf(models[0]) : models[0]?.id ?? '',
    description: PROVIDER_DESCRIPTION,
    keyConfigured: true,
    models: models.map(model => mofangModelEntry(model, { idOf, labelOf })),
    [OWNER_FIELD]: owner,
  };
}

// 把 provider 合并进配置：先摘掉自己旧的条目，再按「id 冲突让给用户」的规矩追加。
// 与 WorkBuddy 的 mergeModels 同一套口径：用户手写的同 id 条目永远赢。
// 家族命名空间（2026-11-28 修正）：墨坊配置里「mobridge*」开头的 provider 都是墨桥写的
// （inspectTargets 也按这个前缀分家）。旧版墨桥写入的条目可能还没带 owner 字段——只认
// owner 会把它当用户自建、报 MOFANG_ID_CONFLICT，从此永远写不进去（用户实锤：
// activeProvider=mobridge-sensenova 的条目就没有 owner 字段）。同 id 且 id 在命名空间内
// 的一律按「迁移」处理：替换成带 owner 的新形状；只有用户自建 id（非 mobridge 前缀）才冲突让位。
export function mergeProvider(document, provider, { providerId = PROVIDER_ID, owner = OWNER } = {}) {
  const list = Array.isArray(document?.providers) ? document.providers : null;
  if (!list) throw new Error('不是受支持的墨坊 config.json 格式（缺少 providers 数组）');
  const existing = list.find(entry => entry?.id === providerId);
  const oursByContract = !!existing && (isOwned(existing, owner)
    || (typeof providerId === 'string' && providerId.startsWith('mobridge')));
  if (provider !== null && existing && !oursByContract) {
    const error = new Error(`墨坊配置里已存在用户自建的 ${providerId} provider，为避免覆盖已跳过写入`);
    (error as Error & { code?: string }).code = 'MOFANG_ID_CONFLICT';
    throw error;
  }
  const kept = list.filter(entry => !isOwned(entry, owner) && entry?.id !== providerId);
  if (provider === null) return { ...document, providers: kept };
  return { ...document, providers: [...kept, provider] };
}

// 供「移除配置」判断到底有没有自己的条目：没有就绝不动文件。
export function inspectOwned(document, { owner = OWNER } = {}) {
  const list = Array.isArray(document?.providers) ? document.providers : [];
  const own = list.filter(entry => isOwned(entry, owner));
  return {
    count: own.length,
    models: own.reduce((sum, entry) => sum + (Array.isArray(entry?.models) ? entry.models.length : 0), 0),
    userProviders: list.filter(entry => !isOwned(entry, owner)).map(entry => entry?.id).filter(Boolean),
    active: typeof document?.activeProvider === 'string' ? document.activeProvider : null,
  };
}

// 写入墨坊配置。models 为空 = 收摊，只摘自己的 provider。
// 与其它目标保持同一套规矩：内容相同不写、写前备份、原子替换、写前再读一次防并发覆盖。
export async function syncMofangProvider(models, endpoint, key, { file, allowEmpty = false, providerId = PROVIDER_ID, owner = OWNER, name = PROVIDER_NAME, idOf, labelOf } = {}) {
  const target = file || (await resolveMofangConfig()).file;
  const old = await fs.readFile(target, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (old === null) {
    if (!models.length && allowEmpty) return { changed: false, count: 0, target: 'mofang', file: target };
    throw new Error('未找到墨坊配置文件；请先启动一次墨坊（~/.mofang/config.json）');
  }
  if (!models.length && !allowEmpty) throw new Error('模型清单为空，已保留墨坊现有配置');
  let document;
  try { document = parseConfig(old); }
  catch { throw new Error('墨坊 config.json 不是可解析的 JSON，已跳过写入'); }
  const provider = models.length ? mofangProvider(models, endpoint, key, { providerId, owner, name, idOf, labelOf }) : null;
  let merged;
  try { merged = mergeProvider(document, provider, { providerId, owner }); }
  catch (error) {
    if (error.code === 'MOFANG_ID_CONFLICT') return { changed: false, count: 0, target: 'mofang', file: target, conflict: true, message: error.message };
    throw error;
  }
  const text = JSON.stringify(merged, null, 2) + '\n';
  if (text === old) return { changed: false, count: models.length, target: 'mofang', file: target };
  const current = await fs.readFile(target, 'utf8').catch(() => null);
  if (current !== old) throw new Error('墨坊配置在写入过程中被修改，请重试');
  const backup = `${target}.mobridge-${Date.now()}.bak`;
  await fs.writeFile(backup, old, { mode: 0o600, flag: 'wx' });
  await pruneBackups(target);
  await atomicWrite(target, text);
  // 摘要里带上「当前激活的 provider 是否已经被摘掉」，让上层能把话说清楚，
  // 而不是让用户回到墨坊后发现模型不见了却不知道为什么。
  const info = inspectOwned(merged, { owner });
  return {
    changed: true,
    count: models.length,
    target: 'mofang',
    file: target,
    activeRemoved: provider === null && info.active === providerId,
    active: info.active,
  };
}

// 界面展示用：这条目标到底写到哪、里面有哪些不属于我们的 provider。
export async function describeMofang(options: { env?: Record<string, string | undefined>; home?: string; savedFile?: string | null } = {}) {
  const { file, exists, home } = await resolveMofangConfig(options);
  if (!exists) return { home, file: null, configFile: file, exists: false, providers: [] as string[], active: null };
  try {
    const document = parseConfig(await fs.readFile(file, 'utf8'));
    const info = inspectOwned(document);
    const list = Array.isArray(document?.providers) ? document.providers : [];
    return {
      home,
      file,
      configFile: file,
      exists: true,
      providers: list.map(entry => entry?.id).filter(Boolean),
      userProviders: info.userProviders,
      active: info.active,
      ownedModels: info.models,
    };
  } catch {
    return { home, file, configFile: file, exists: true, providers: [] as string[], active: null, error: '配置无法解析' };
  }
}
