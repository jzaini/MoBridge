import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolveModelsFile, validateModelsFile } from '../config/workbuddy-config.ts';
import { searchConfig, windowsSearchRoots } from '../config/config-finder.ts';
import { dataDirectory } from './platform.ts';
import { findRuntime, startBackend } from './runtime.ts';
import { createServer } from './server.ts';
import { listenService } from './service-instance.ts';
import { systemProxyEnvironment } from '../config/system-proxy.ts';
import { prepare, BridgeError } from '../domain/protocol.ts';
import { probeBody, probeModel, probeFailure, formatUnsupported } from '../domain/probe.ts';
import { modelResult, withRequestMeta, usableModelIds } from '../domain/model-status.ts';
import { atomicWrite, syncModels, isOwnedEntry } from '../sync/sync.ts';
import { syncDshProvider, listDshProfiles, locateDshHome, ownedProviderIds } from '../config/dsh-config.ts';
import { syncMofangProvider, describeMofang, resolveMofangConfig } from '../config/mofang-config.ts';
import {
  pickPathPatch, validateTargetPath, locateWorkbuddyFile, PATH_TARGET, TARGET_LABEL,
  type TargetKey, type PathKey,
} from '../config/target-paths.ts';
import { SOURCE_OWNERS } from '../sync/sync.ts';
import {
  allModels as snModels, readKey as snReadKey, saveKey as snSaveKey, clearKey as snClearKey,
  maskKey as snMaskKey, readApiBase as snReadApiBase, saveApiBase as snSaveApiBase,
  readSelection as snReadSelection, saveSelection as snSaveSelection,
  API_BASE as SN_API_BASE, DEFAULT_PROBE_MODEL as SN_PROBE_MODEL,
  KEYS_URL as SN_KEYS_URL, DOCS_URL as SN_DOCS_URL, CONTEXT_UNKNOWN as SN_CONTEXT_UNKNOWN,
} from '../config/sensenova.ts';
import { validateKey as snValidate, probeAll as snProbeAll } from '../domain/sensenova.ts';
import { createProbeCache } from '../domain/probe-cache.ts';
import { normalizeSettings, pickKnownKeys } from '../domain/settings.ts';
import {
  detectAtomcode, runInstall, runLogin, readAuth, accountInfo,
  readGateway, saveGateway, installCommands, atomcodeHome,
  readSelection as acReadSelection, saveSelection as acSaveSelection,
  DEFAULT_PLAN_API as AC_PLAN_API, OFFICIAL_DOC as AC_DOC, OFFICIAL_SITE as AC_SITE,
} from '../config/atomcode.ts';
import { loadCatalog as acLoadCatalog, readOfflineModels as acReadOffline, clearCatalogCache as acClearCache } from '../domain/atomcode.ts';
import { startAtomcodeBridge } from './atomcode-bridge.ts';

// 服务端进程：Electron 以 fork 方式拉起它，也可以直接 `npm start` 独立运行。
// 它只监听 127.0.0.1，口令是一次一发的本地密钥，所有状态都写在数据目录里。
const dataDir = process.env.MOBRIDGE_DATA_DIR || dataDirectory();
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
// 设置必须在监听之前读：端口本身就是一个用户可改的项（见 domain/settings.ts）。
// 优先级：环境变量（主进程按设置算好后传下来）> settings.json > 默认值。
const settingsFile = path.join(dataDir, 'settings.json');
let settings = {};
try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch {}
// 可配置项：从 settings.json 里读出来单独归一化一份。settings 留着当"整份配置"，
// 它是磁盘上真实的内容（还带着 target / excludedModels 这些）；serviceSettings 只装
// 用户能在设置面板里改的那几个旋钮，读写都走 normalizer，不会被脏数据带偏。
let serviceSettings = normalizeSettings(settings);
const port = Number(process.env.MOBRIDGE_PORT || serviceSettings.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid MOBRIDGE_PORT: ${port}`);
// AtomCode 转发口：两条链路协议不同，必须各占一个端口。
const atomcodePort = Number(process.env.MOBRIDGE_ATOMCODE_PORT || serviceSettings.atomcodePort);
const lockFile = path.join(dataDir, 'service.pid');
let server = await listenService(port);
await fs.writeFile(lockFile, String(process.pid), { mode: 0o600 });
const tokenFile = path.join(dataDir, 'api-key');
let key;
try { key = (await fs.readFile(tokenFile, 'utf8')).trim(); }
catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32).toString('hex'); await fs.writeFile(tokenFile, key, { flag: 'wx', mode: 0o600 }); }
const endpoint = `http://127.0.0.1:${port}/v1`;
let models = [], runtime, binary, stopping = false, refreshing;
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8')); } catch {}
// 写入目标：WorkBuddy 的 models.json、DSH 各 profile 的 cordis.patch.yml，
// 或墨坊 config.json 里的一条 provider。同一时间只认一个目标，
// 切换时把旧目标里自己的条目摘干净。
// 路径覆写从同一份 settings.json 读，三个目标各自传给自己的解析函数。
// 用函数而不是常量：设置面板改完路径后 settings 会被整体替换，这里要跟着变。
const mofangOptions = () => ({ savedFile: settings.mofangConfigFile as string | undefined });
const dshOptions = () => ({ saved: settings.dshHome as string | undefined });
let dshHome = locateDshHome(dshOptions());
let dshProfiles = await listDshProfiles(dshHome);
const dshAttachment = () => ({ home: dshHome, profiles: dshProfiles.map(profile => profile.name) });
// 墨坊：真正存在的配置文件可能在新目录，也可能在兼容保留的旧目录，
// 所以每次写入前都重新定位一次，而不是把路径钉死在启动那一刻。
let mofangInfo = await describeMofang(mofangOptions());
const mofangAttachment = () => ({
  home: mofangInfo.home, file: mofangInfo.file, configFile: mofangInfo.configFile,
  providers: mofangInfo.providers, active: mofangInfo.active, exists: mofangInfo.exists,
});
// 日日新：没有动态模型目录，也没有本机转发口——客户端直接连上游，用的是用户自己的 Key。
// 所以这里只管三件事：Key 存哪、真实可用性怎么量、勾选写进哪个目标。
let snKey = await snReadKey(dataDir);
let snBase = await snReadApiBase(dataDir);
let snSelection = await snReadSelection(dataDir) ?? snModels().map(model => model.upstream);
let snValidation: Awaited<ReturnType<typeof snValidate>> & { time?: string } | null = null;
let snProbeResults = {};
let snLastWrite: { time: string, target: string, count: number, changed: boolean } | null = null;
const snSnapshot = () => ({
  keyPresent: !!snKey, keyMask: snMaskKey(snKey),
  validated: snValidation?.ok === true, validation: snValidation,
  models: snModels(), probeResults: snProbeResults, selection: snSelection,
  apiBase: snBase.apiBase, apiBaseCustom: snBase.custom, apiBaseDefault: SN_API_BASE,
  probeModel: SN_PROBE_MODEL, contextUnknown: SN_CONTEXT_UNKNOWN,
  keysUrl: SN_KEYS_URL, docsUrl: SN_DOCS_URL, write: snLastWrite,
});
// AtomCode：本机要装客户端、要登录、上游还要注入专属头，所以这一路必须走独立转发口。
// 状态里只暴露「装没装 / 登没登 / 目录从哪来 / 转发口在哪」，token 本身不出主进程。
let acFound = await detectAtomcode();
let acAuth = await readAuth();
let acCatalog = await acLoadCatalog(acAuth.values.access_token as string || null, { home: atomcodeHome() });
let acSelection = await acReadSelection(dataDir);
let acGateway = await readGateway(dataDir);
let acBridge: Awaited<ReturnType<typeof startAtomcodeBridge>> | null = null;
let acGate = { command: installCommands().command, official: AC_DOC };
const acToken = () => (typeof acAuth.values.access_token === 'string' ? acAuth.values.access_token as string : null);
const acModels = () => acCatalog.models;
if (acSelection === null) acSelection = acModels().map(model => model.upstream);
const acSnapshot = () => ({
  installed: acFound.installed, version: acFound.version, binary: acFound.path,
  loggedIn: !!acToken() && acCatalog.source === 'live',
  account: accountInfo(acAuth.values, acAuth.mtimeMs),
  models: acModels().map(model => ({ id: model.id, upstream: model.upstream, name: model.name, context: model.context, images: model.images, levels: model.levels })),
  selection: acSelection,
  catalogSource: acCatalog.source, plan: acCatalog.plan,
  fetchedAt: acCatalog.fetchedAt, catalogError: acCatalog.error, planAPI: AC_PLAN_API,
  gateway: acGateway.gateway, gatewayCustom: acGateway.custom,
  bridgeRunning: !!acBridge, endpoint: acBridge?.endpoint ?? null,
  install: acGate, loginCommand: 'atomcode login', docsUrl: AC_DOC, siteUrl: AC_SITE,
});
const target = ['workbuddy', 'dsh', 'mofang'].includes(settings.target) ? settings.target : 'workbuddy';
// 状态里会带上一轮留下的检测结果：重启后面板不至于一片空白，但也不当成新结论。
// ── 写入目标体检 ─────────────────────────────────────────────────────────
// 三个目标各回答两个问题：① 这个客户端的配置在不在（能不能写）② 里面现在有没有我们的条目（能不能移除）。
// 必须现读：用户随时可能在别的工具里改配置，缓存一份结论只会让按钮骗人。
const OWNERS = Object.values(SOURCE_OWNERS);
// 三条接入线共写同一份配置，所以「这里有 N 条」这句话必须说清是谁的。
// WorkBuddy 靠条目的 owner 字段分家，DSH / 墨坊 靠 provider id 前缀：mobridge、
// mobridge-atomcode、mobridge-sensenova——前缀匹配要给长的优先，否则 atomcode 会被记到 opencode 头上。
const PROVIDER_PREFIX: Record<keyof typeof SOURCE_OWNERS, string> = {
  opencode: 'mobridge',
  atomcode: 'mobridge-atomcode',
  sensenova: 'mobridge-sensenova',
};
function emptySourceCounts() {
  const counts = {};
  for (const key of Object.keys(SOURCE_OWNERS)) counts[key] = { count: 0, ids: [] };
  return counts;
}
function countByProvider(ids: string[]) {
  const counts = emptySourceCounts();
  for (const id of ids) {
    const hit = (Object.entries(PROVIDER_PREFIX) as Array<[string, string]>)
      .sort((a, b) => b[1].length - a[1].length)
      .find(([, prefix]) => id === prefix || id.startsWith(prefix + '-'));
    if (hit) { counts[hit[0]].count += 1; counts[hit[0]].ids.push(id); }
  }
  return counts;
}
async function inspectTargets() {
  const report = {};
  // WorkBuddy：models.json 里的条目按 owner 标记认领。
  // ids 一起带出来：面板要能说清"到底写了哪几个模型"，而不是只给个数字。
  if (modelsFile) {
    try {
      const document = JSON.parse((await fs.readFile(modelsFile, 'utf8')).replace(/^\uFEFF/, ''));
      const list = Array.isArray(document) ? document : (document?.models || []);
      const owned = list.filter(entry => OWNERS.some(owner => isOwnedEntry(entry, owner)));
      const sources = emptySourceCounts();
      for (const entry of owned) {
        const hit = (Object.entries(SOURCE_OWNERS) as Array<[string, string]>)
          .find(([, owner]) => isOwnedEntry(entry, owner));
        if (!hit) continue;
        const id = String(entry.id || entry.name || '');
        sources[hit[0]].count += 1;
        if (id) sources[hit[0]].ids.push(id);
      }
      report.workbuddy = { available: true, file: modelsFile, owned: owned.length, sources, ids: owned.map(entry => String(entry.id || entry.name || '')).filter(Boolean) };
    } catch (error) {
      report.workbuddy = { available: false, file: modelsFile, owned: 0, sources: emptySourceCounts(), ids: [], note: error.message };
    }
  } else report.workbuddy = { available: false, file: null, owned: 0, sources: emptySourceCounts(), ids: [], note: '尚未定位 models.json' };
  // DSH：每个 profile 的 patch 里数 provider 键。
  dshProfiles = await listDshProfiles(dshHome);
  const dshIds = [];
  for (const profile of dshProfiles) {
    const text = await fs.readFile(profile.patchFile, 'utf8').catch(() => null);
    dshIds.push(...ownedProviderIds(text));
  }
  report.dsh = { available: dshProfiles.length > 0, profiles: dshProfiles.map(profile => profile.name), owned: dshIds.length, sources: countByProvider(dshIds), ids: dshIds, note: dshProfiles.length ? null : '未检测到 DSH profile' };
  // 墨坊：providers 数组里数带我们前缀的 id。
  mofangInfo = await describeMofang(mofangOptions());
  const mofangIds = (mofangInfo.providers || []).filter(id => String(id).startsWith('mobridge')).map(String);
  report.mofang = {
    available: mofangInfo.exists, file: mofangInfo.file,
    owned: mofangIds.length,
    sources: countByProvider(mofangIds),
    ids: mofangIds,
    note: mofangInfo.exists ? null : '未检测到墨坊配置',
  };
  return report;
}
async function refreshTargets() {
  try {
    const targets = await inspectTargets();
    update({ targets, targetPaths: await describeTargetPaths() });
  } catch (error) { log.write(`${new Date().toISOString()} 目标体检失败：${error.message}\n`); }
}

let state = { useSystemProxy: settings.useSystemProxy === true || (process.platform === 'win32' && settings.useSystemProxy !== false), phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.2.0', opencodeVersion: null, models: [], excludedModels: settings.excludedModels || [], modelResults: previous.modelResults || {}, sync: null, availableModels: [], probe: { running: false }, target, targets: {}, settings: serviceSettings, cacheEntries: 0, dsh: dshAttachment(), mofang: mofangAttachment(), sensenova: snSnapshot(), atomcode: acSnapshot() };
// 状态写入串行化：一个慢的异步更新不能盖掉后发生的状态。
let statusWrites = Promise.resolve();
function update(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  const text = JSON.stringify(state, null, 2);
  statusWrites = statusWrites.then(() => atomicWrite(path.join(dataDir, 'status.json'), text)).catch(e => console.error('Status write failed:', e.message));
}
const logFile = path.join(dataDir, 'opencode.log');
try { if ((await fs.stat(logFile)).size > 5 * 1024 * 1024) await fs.rename(logFile, logFile + '.previous'); } catch {}
const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
// 判定缓存：新鲜的判定直接用，不重新探测（见 probe-cache.js 的过期策略）。
// 目录变化后由 prune 清理，显式点"检测全部"时整体忽略。
const probeCache = createProbeCache({
  file: path.join(dataDir, 'probe-cache.json'),
  // 环境变量优先级高于用户设置：自动化/排障时用一个临时值覆盖，不必去改面板。
  okTtlMinutes: Number(process.env.MOBRIDGE_PROBE_TTL_MINUTES || serviceSettings.probeCacheMinutes) || undefined,
  rejectTtlMinutes: serviceSettings.rejectTtlMinutes,
  transientTtlMinutes: serviceSettings.transientTtlMinutes,
  log: message => log.write(`${new Date().toISOString()} ${message}\n`),
});
// 检测并发：串行等 11 个模型时，光两次超时就够等两分钟。并发跑让慢模型互相重叠，
// 一轮基本只取决于最慢的那一批。上游对并发敏感，默认保守取 3。
// 每次开队列时现读设置：用户把并发调小之后，下一轮就该按新的来。
const probeConcurrency = () => Math.max(1, Math.min(6, Number(process.env.MOBRIDGE_PROBE_CONCURRENCY || serviceSettings.probeConcurrency) || 3));
// 只有"被检测通过"且"最近一次结果 ok"的模型才对外发布。
const validated = new Set();
const usableModels = () => models
  .filter(m => validated.has(m.id) && state.modelResults[m.id]?.ok === true)
  .map(m => ({ ...m, chatOnly: state.modelResults[m.id]?.chatOnly === true }));
const publishedModels = usableModels;
// 翻译兜底要挑另一个能干活的免费模型：顺序是偏好，列表为空时退到任意可用模型。
// 检测路径永远不翻译——探测必须量到模型本身，而不是翻译的功劳。
const TRANSLATOR_ORDER = ['opencode/big-pickle', 'opencode/nemotron-3.5-lightning-free', 'opencode/space-bunny-free', 'opencode/mimo-v2.6-flash-free'];
const attachTranslator = runtime => {
  runtime.backend.translator = failed => {
    const usable = usableModels().map(model => model.id).filter(id => id !== failed);
    return TRANSLATOR_ORDER.find(id => usable.includes(id)) ?? usable[0] ?? null;
  };
  return runtime;
};
let syncWrites = Promise.resolve();
let modelsFile = process.platform === 'win32'
  ? await resolveModelsFile({ saved: settings.workBuddyModelsFile })
  : process.env.MOBRIDGE_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');
update({ modelsFile });

// 写入位置现状：设置里指定的值、实际解析到的路径、是否真的存在。
// 设置面板与目标卡都用它，避免「以为写进 A、其实写到 B」。
async function describeTargetPaths() {
  const isFile = async (file?: string | null) => !!(file && (await fs.stat(file).catch(() => null))?.isFile());
  const mofang = await resolveMofangConfig(mofangOptions());
  return {
    workbuddy: {
      configured: settings.workBuddyModelsFile || null,
      resolved: modelsFile || null,
      exists: await isFile(modelsFile),
      note: modelsFile ? null : '尚未定位 models.json；点「自动查找」或「更改…」',
    },
    dsh: {
      configured: settings.dshHome || null,
      resolved: dshHome,
      exists: dshProfiles.length > 0,
      note: dshProfiles.length ? null : '该目录下没有可用的 DSH profile',
    },
    mofang: {
      configured: settings.mofangConfigFile || null,
      resolved: mofang.file,
      exists: mofang.exists,
      note: mofang.exists ? null : '未找到 config.json；请先启动一次墨坊，或手动指定',
    },
  };
}
update({ targetPaths: await describeTargetPaths() });

// 换路径前，旧位置里墨桥写过的条目必须摘掉（三路来源都摘），
// 否则用户会在旧配置里留下一堆指向本机转发口的死条目。
async function cleanupOldPaths(targets: TargetKey[]) {
  await syncWrites; // 等排队中的写入落完，避免刚清完又被写回去
  for (const target of targets) {
    for (const [source, owner] of Object.entries(SOURCE_OWNERS) as Array<[keyof typeof SOURCE_OWNERS, string]>) {
      const providerId = PROVIDER_PREFIX[source];
      try {
        if (target === 'workbuddy') {
          if (!modelsFile || !(await fs.stat(modelsFile).catch(() => null))) continue;
          await syncModels(modelsFile, [], '', '', { owner, allowEmpty: true, requireExisting: false });
        } else if (target === 'dsh') {
          if (!dshProfiles.length) continue;
          await syncDshProvider(dshProfiles, [], '', '', { providerId, allowEmpty: true });
        } else {
          const { file, exists } = await resolveMofangConfig(mofangOptions());
          if (!exists) continue;
          await syncMofangProvider([], '', '', { file, allowEmpty: true, providerId, owner });
        }
      } catch (error) {
        // 旧位置可能已被用户删掉：清不掉不是致命错，但要留痕，不能假装成功。
        log.write(`${new Date().toISOString()} 清理旧写入位置失败（${target}/${source}）：${error.message}\n`);
      }
    }
  }
}

// 用「即将落盘」的设置更新运行时路径，落盘失败时由调用方回滚这份快照。
async function applyTargetPaths(nextSettings) {
  const saved = nextSettings.workBuddyModelsFile as string | undefined;
  modelsFile = saved
    ? (process.platform === 'win32' ? await validateModelsFile(path.resolve(saved)) : path.resolve(saved))
    : (process.platform === 'win32' ? await resolveModelsFile({})
      : (process.env.MOBRIDGE_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json')));
  dshHome = locateDshHome({ saved: nextSettings.dshHome as string | undefined });
  dshProfiles = await listDshProfiles(dshHome);
  mofangInfo = await describeMofang({ savedFile: nextSettings.mofangConfigFile as string | undefined });
  update({ modelsFile, dsh: dshAttachment(), mofang: mofangAttachment() });
}

// 三个目标的写入形态不同：WorkBuddy 吃一份 models.json 清单，DSH 吃 profile patch
// 里的 llm-pi-ai provider，墨坊吃 config.json 的 providers 数组。对外都返回 {changed, count, target}。
async function writePublished(target, published) {
  if (target === 'dsh')
    return syncDshProvider(dshProfiles, published, endpoint, key, { allowEmpty: true });
  if (target === 'mofang') {
    // 每次写入前重新定位：用户可能刚把旧的 ~/.ai-coding-tool 换成 ~/.mofang。
    mofangInfo = await describeMofang(mofangOptions());
    const { file } = await resolveMofangConfig(mofangOptions());
    return syncMofangProvider(published, endpoint, key, { file, allowEmpty: true });
  }
  if (!modelsFile) throw new Error('未找到有效的 WorkBuddy 配置，请点击导入并选择 models.json；首次使用请先在 WorkBuddy 保存一个自定义模型。');
  return syncModels(modelsFile, published, `${endpoint}/chat/completions`, key, { allowEmpty: true, requireExisting: process.platform === 'win32' });
}

// 导入的写操作也串行化：两次并发写入会把同一份配置写乱。
function syncPublished(published = publishedModels().filter(m => !(settings.excludedModels || []).includes(m.id))) {
  syncWrites = syncWrites.then(async () => {
    let sync;
    const active = state.target || 'workbuddy';
    if (process.env.MOBRIDGE_NO_SYNC === '1') sync = { skipped: true, count: published.length, target: active };
    else {
      try { sync = await writePublished(active, published); }
      catch (e) { sync = { error: e.message, target: active }; }
    }
    update({ sync: { ...sync, time: new Date().toISOString() } });
    await refreshTargets();
    return sync;
  });
  return syncWrites;
}
async function record(model, ok, error, status, code, durationMs, source = 'request', chatOnly = source === 'request' && state.modelResults[model]?.chatOnly === true, meta = {}) {
  if (stopping) return;
  const result = withRequestMeta({ model, ...modelResult(ok, error, status, code), durationMs, source, chatOnly }, meta);
  // 原始审批载荷留档：事后还查得出被拦下的是哪种本机动作。
  const captured = Array.isArray(meta.permissions) && meta.permissions.length ? { lastPermission: { time: result.time, entries: meta.permissions } } : {};
  // 上游自身出问题是"这一轮"的事，不是对模型的判定：
  // 记账照记，但模型继续留在可用列表里，不让一次抽风把它撤下。
  if (!ok && source === 'request' && ['invalid_model_output', 'invalid_tool_call', 'native_tool_activity', 'output_truncated'].includes(code)) {
    update({ lastRequest: result, ...captured });
    return;
  }
  if (ok) validated.add(model); else validated.delete(model);
  update({ lastRequest: result, ...(model ? { modelResults: { ...state.modelResults, [model]: result } } : {}), ...captured });
  update({ availableModels: usableModels().map(m => m.id) });
  // 判定入缓存。探测结论照收；真实调用的成功也是证据（顺手把时间戳刷新，
  // 下次启动就不会再为它跑一遍探测）。真实调用失败不动缓存——一次抽风不是对模型的判定。
  const entry = model ? models.find(m => m.id === model) : undefined;
  if (entry && source === 'probe') probeCache.record(entry, { ok, chatOnly, category: result.category, message: result.error, durationMs, at: Date.parse(result.time) });
  else if (entry && ok && source === 'request') probeCache.record(entry, { ok: true, chatOnly, category: 'available', durationMs, at: Date.parse(result.time) });
}
// 在途可见性：慢或被上游重试的一轮在请求/响应上完全没有输出，
// 所以把 OpenCode 事件流上的进展发布出去，面板才能说清"卡在哪一步"。
const activities = new Map();
let activityTimer;
function publishActivity() {
  const now = Date.now();
  update({ activity: [...activities.values()].map(a => ({
    model: a.model, sessionID: a.sessionID, status: a.status || 'waiting',
    waitedMs: now - a.startedAt, sinceEventMs: a.lastEventAt ? now - a.lastEventAt : null,
    sinceContentMs: a.lastContentAt ? now - a.lastContentAt : null, repairModel: a.repairModel,
    attempt: a.attempt, ...(a.error ? { error: a.error } : {}),
  })) });
}
function noteActivity(progress) {
  if (!progress?.sessionID) return;
  if (progress.type === 'request.done') { activities.delete(progress.sessionID); publishActivity(); return; }
  const entry = activities.get(progress.sessionID) || { sessionID: progress.sessionID, startedAt: Date.now(), status: 'waiting' };
  Object.assign(entry, progress, { model: progress.model || entry.model, lastEventAt: Date.now() });
  if (progress.content) entry.lastContentAt = Date.now();
  activities.set(progress.sessionID, entry);
  // 上游安静时，等待时间仍然要继续走。
  if (!activityTimer) {
    activityTimer = setInterval(() => { if (activities.size) publishActivity(); else { clearInterval(activityTimer); activityTimer = null; } }, 5000);
    activityTimer.unref?.();
  }
  // 关键节点（换阶段、上游重试、审批、出错）立刻写，普通进展最多每秒写一次。
  const urgent = progress.type === 'bridge.phase' || progress.status === 'retry' || progress.status === 'permission' || progress.error;
  const now = Date.now();
  if (!urgent && now - (entry.writtenAt || 0) < 1000) return;
  entry.writtenAt = now;
  publishActivity();
}
let probing = false, probeTask;
const probeAbort = new AbortController();

// 缓存里还有新鲜判定的模型直接采用：不花一次请求，也不再等它。
// 采用失败的判定同样有价值——它让"重启后又要为两个死模型各等一分钟"消失。
// 只有按能力指纹与过期时间都算新鲜的才算数（见 probe-cache.js）。
function adoptCachedModels(candidates) {
  const adopted = {};
  let count = 0;
  for (const model of candidates) {
    const verdict = probeCache.fresh(model);
    if (!verdict) continue;
    if (verdict.ok) validated.add(model.id);
    adopted[model.id] = {
      model: model.id, ok: verdict.ok === true, category: verdict.category ?? (verdict.ok ? 'available' : 'error'),
      time: new Date(verdict.at).toISOString(), source: 'cache', chatOnly: verdict.chatOnly === true,
      ...(Number.isFinite(verdict.durationMs) ? { durationMs: verdict.durationMs } : {}),
      ...(verdict.message ? { error: verdict.message } : {}),
    };
    count += 1;
  }
  if (count) {
    // 先合并出新的结果表，再拿它算可用清单。update() 是"算完 patch 才换 state"，
    // 这里如果直接调 usableModels()，读到的是上一份 modelResults：
    // "缓存判定成功、但上一轮结果失败"的模型就会被漏掉，而且再没有别的机会补上。
    const modelResults = { ...state.modelResults, ...adopted };
    update({ modelResults, availableModels: usableModelIds(models, validated, modelResults) });
  }
  return count;
}

// 探测一个模型。每个模型有自己的超时预算（默认 60 秒，可在设置里调），
// 语义没命中（只回文本、动作不符）重试一次并共用同一份预算；判定一律经 record() 落进状态与缓存。
async function probeOneModel(model) {
  const started = performance.now();
  const timeoutMs = serviceSettings.probeTimeoutMs;
  const elapsed = () => Math.round(performance.now() - started);
  let limitMessage = null;  // 上游明确说额度/配额到顶：当场收手，别陪着退避重试
  let lastRetry = null;     // 只是一般的重试：留着，超时时用来解释原因
  const deadline = new AbortController();
  let timedOut = false;
  const meta = {
    probe: true,
    // 本地 OpenCode 收到 429 会自己退避重试，重试事件里带着上游原话。
    // 不接这个信号的话，用户看到的就是「检测中」干等 60 秒、最后记成「超时」——
    // 明明上游一秒就回了「免费额度已用完」。所以这里既用来提前收手，也用来给出真实原因。
    activity: info => {
      if (info.status !== 'retry' || !info.message) return;
      lastRetry = info.message;
      if (!/usage (limit|exceed)|quota|limit reached|subscribe|out of credits|insufficient|额度|配额|余额/i.test(info.message)) return;
      limitMessage = info.message;
      deadline.abort();
    },
  };
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
  try {
    // OpenCode 目录里明说没有工具能力的模型不必浪费一次探测。
    if (model.toolcall === false) throw new BridgeError('OpenCode catalog does not advertise tool support', 502, 'invalid_tool_call');
    await probeModel({ complete: token => runtime.backend.complete(prepare(probeBody(model, token), models), AbortSignal.any([probeAbort.signal, deadline.signal]), meta) });
    await record(model.id, true, undefined, undefined, undefined, elapsed(), 'probe', undefined, meta);
  } catch (cause) {
    const e = limitMessage
      ? new BridgeError(limitMessage, 429, 'rate_limited')
      : timedOut && lastRetry
        ? new BridgeError(`${lastRetry}（等待 ${Math.round(elapsed() / 1000)} 秒仍未出结果）`, 504, 'timeout')
        : probeFailure(cause, timedOut);
    if (!stopping && e.code === 'no_action') {
      // 只回文本说明"能用"，不是"不能用"：按仅对话发布并关掉工具，而不是撤下它。
      await record(model.id, true, '探测时只返回文本、未产生动作；已按仅对话发布', undefined, 'chat_only', elapsed(), 'probe', true);
    } else if (!stopping && formatUnsupported(e)) {
      // 格式装不下工具调用：再用一次纯对话确认它至少能聊天，能就按仅对话发布。
      // 这一问只要一个字，但从一半预算起算：用户把检测超时调短时它不该还硬等 30 秒。
      try {
        const chatModel = { ...model, chatOnly: true };
        const chatBudget = Math.max(5000, Math.min(30000, Math.round(timeoutMs / 2)));
        await runtime.backend.complete(prepare({ model: model.id, messages: [{ role: 'user', content: 'Reply only OK.' }] }, [chatModel]), AbortSignal.any([probeAbort.signal, AbortSignal.timeout(chatBudget)]));
        await record(model.id, true, '工具转换不兼容：' + e.message, undefined, 'chat_only', elapsed(), 'probe', true);
      } catch (chatError) {
        if (!stopping) await record(model.id, false, chatError.message, chatError.status, chatError.code, elapsed(), 'probe');
      }
    } else if (!stopping) await record(model.id, false, e.name === 'TimeoutError' ? 'Model probe timed out' : e.message, e.status, e.code, elapsed(), 'probe', undefined, meta);
  } finally { clearTimeout(timer); }
}

// 检测队列。force 用于"检测全部"：那是用户明确要求重新验证，缓存一律忽略。
function startProbes(modelID, reveal = false, autoImport = false, { force = false } = {}) {
  if (stopping || refreshing || configSearch) throw new Error('请等待模型读取或配置查找完成');
  if (probing) return { started: false, message: '检测正在进行' };
  const selected = modelID ? models.filter(m => m.id === modelID) : models;
  if (!selected.length) throw new Error('模型不在当前目录中');
  probing = true;
  // 先采用缓存判定，剩下的才需要真的发请求。
  const reused = force ? 0 : adoptCachedModels(selected);
  const reusable = new Set(selected.filter(model => probeCache.fresh(model)).map(model => model.id));
  const queue = selected.filter(model => force || !reusable.has(model.id));
  // 计划数要在 worker 开跑之前记下来：它们会立刻把队首领走，事后读 queue.length 会得到 0。
  const planned = queue.length;
  const pending = queue.map(model => model.id);
  const active = new Set();
  // total/done 是给页面画进度条用的：用户点完「检测全部」就把弹窗关掉了，
  // 页面上（尤其右下角的进度条）得能说出"还剩几个"，而不是只转一个圈。
  // done = 计划数 - 队列剩余 - 正在跑，这样出结论的瞬间数字就动，不用等下一轮。
  const publishProbe = () => update({
    probe: {
      running: true,
      current: [...active][0] ?? null,
      active: [...active],
      pending: [...pending],
      total: planned,
      done: Math.max(0, planned - pending.length - active.size),
    },
  });
  probeTask = (async () => {
    try {
      if (reveal) {
        // 幂等：单模型重测时它已经在清单里，不应该再插一行。
        const known = new Set(state.models.map(model => model.id));
        const added = selected.filter(model => !known.has(model.id));
        if (added.length) update({ models: [...state.models, ...added] });
      }
      publishProbe();
      // 并发工作池：每个 worker 领一个模型跑完再领下一个。上游对并发敏感，
      // 所以并发度保守（默认 3），并且慢模型不再挡住快模型出结果。
      const workers = Array.from({ length: Math.min(probeConcurrency(), queue.length) }, async () => {
        while (queue.length && !stopping) {
          const model = queue.shift();
          active.add(model.id);
          publishProbe();
          try { await probeOneModel(model); }
          finally {
            active.delete(model.id);
            pending.splice(pending.indexOf(model.id), 1);
            publishProbe();
          }
        }
      });
      await Promise.all(workers);
      // 目录里已经没有的模型，判定留着只会让缓存越来越大。
      probeCache.prune(models);
      // 首次启动的整轮检测跑完就自动导入一次：这是"打开就能用"的那一步。
      if (autoImport && !stopping) {
        if (process.platform === 'win32' && !modelsFile && process.env.MOBRIDGE_NO_SYNC !== '1') {
          const found = await findConfig(true);
          if (found.candidates.length) {
            await validateModelsFile(found.candidates[0]);
            settings = { ...settings, workBuddyModelsFile: found.candidates[0] };
            await atomicWrite(settingsFile, JSON.stringify(settings));
            modelsFile = found.candidates[0]; update({ modelsFile });
          }
        }
        await syncPublished();
      }
      log.write(`${new Date().toISOString()} 检测轮结束：判定缓存命中 ${reused} 个，实际探测 ${planned} 个\n`);
    } finally {
      probing = false;
      // 收尾时把 total/done 都定格在满格：页面的进度条读的是这两个数，
      // 留空会让它在"已完成"的瞬间跳回 0/N。
      update({ probe: { running: false, current: null, active: [], pending: [], total: planned, done: planned }, cacheEntries: probeCache.size() });
    }
  })().catch(e => console.error('Model detection failed:', e.message));
  return { started: true, reused, probing: planned };
}

function watchRuntime(current) {
  update({ opencodeVersion: current.version });
  current.child.on('exit', () => {
    // 隔离服务死掉之后所有转发都会失败，与其让 WorkBuddy 一个个超时，不如当场收摊。
    if (!stopping && runtime === current) {
      update({ phase: 'error', message: 'OpenCode 服务退出，请重启代理' });
      shutdown(1);
    }
  });
}

// 重新读取模型目录。restartRuntime 用于切换代理：OpenCode 的启动环境是固定的，
// 代理变了只能换一个进程，而新进程就绪之前旧进程继续服务。
async function refresh(restartRuntime = false, useSystemProxy = state.useSystemProxy) {
  if (refreshing) return refreshing;
  if (probing || stopping || configSearch) throw new Error('请等待检测或配置查找完成');
  const proxyEnv = await systemProxyEnvironment(useSystemProxy);
  validated.clear();
  models = [];
  update({ phase: 'reading', message: '正在读取免费模型…', models: [], availableModels: [] });
  refreshing = (async () => {
    if (restartRuntime) {
      const next = attachTranslator(await startBackend(binary, dataDir, log, proxyEnv));
      if (stopping) { await next.stop(); return; }
      const old = runtime;
      runtime = next;
      watchRuntime(next);
      await old?.stop();
      update({ useSystemProxy });
    }
    const discovered = await runtime.backend.models();
    if (stopping) return;
    models = discovered;
    update({ phase: 'ready', message: `运行中 · ${models.length} 个免费模型` });
    return { count: models.length };
  })();
  try { return await refreshing; }
  catch (e) { if (!stopping) update({ phase: 'error', message: `读取失败：${e.message}` }); throw e; }
  finally { refreshing = null; }
}

// "读取免费模型"= 重读目录 + 补齐缺失的判定；缓存里新鲜的沿用，不重复花请求。
// 要强制重新验证应该点"检测全部"（force）。
async function readModels() {
  const result = await refresh(true);
  if (!stopping) startProbes(undefined, true);
  return result;
}
async function setSystemProxy(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('代理开关必须是布尔值');
  if (refreshing || probing || stopping || configSearch) throw new Error('请等待读取和检测完成');
  await refresh(true, enabled);
  if (stopping) return;
  settings = { ...settings, useSystemProxy: enabled };
  await atomicWrite(settingsFile, JSON.stringify(settings));
  startProbes(undefined, true);
  return { useSystemProxy: enabled };
}
let configSearch;
async function findConfig(afterProbe = false) {
  if (process.platform !== 'win32') throw new Error('自动查找仅用于 Windows');
  if (stopping || refreshing || !runtime || (probing && !afterProbe)) throw new Error('请等待服务就绪');
  if (configSearch) return configSearch;
  configSearch = (async () => {
    update({ configSearch: { running: true }, message: 'OpenCode 正在只读查找 WorkBuddy 配置…' });
    try {
      const result = await searchConfig(runtime.backend, usableModels(), await windowsSearchRoots(os.homedir()), probeAbort.signal);
      if (!stopping) update({ configSearch: { running: false, ...result }, message: '运行中' });
      return result;
    } catch (error) {
      if (!stopping) update({ configSearch: { running: false, candidates: [], errors: [error.message] } });
      throw error;
    }
  })();
  try { return await configSearch; } finally { configSearch = null; }
}

// 只读的「自动查找」：只给出路径，不触发写入（写入由设置面板拿到路径后统一提交）。
// 与 old find-config 的区别是它不会顺手 import —— 用户在设置里只想改位置，不想被写一次配置。
async function autoLocatePath(target) {
  if (target === 'workbuddy') {
    // 只用本地 stat 找常见位置，绝不启动跨盘模型查找（那条路依赖 OpenCode runtime，
    // 首启时能挂几分钟，设置面板的按钮会像死了一样）。放得偏就用「更改…」手动选。
    const file = await locateWorkbuddyFile();
    if (!file) throw new Error('没有在常见位置找到 WorkBuddy 的 models.json，请点「更改…」手动选择');
    return { target, path: file };
  }
  if (target === 'dsh') {
    const home = locateDshHome(); // 不带 saved：这次要看的是内置默认规则
    const profiles = await listDshProfiles(home);
    if (!profiles.length) throw new Error(`默认目录下没有 DSH profile：${home}；请先启动一次 DSH 或手动指定目录`);
    return { target, path: home };
  }
  if (target === 'mofang') {
    const { file, exists } = await resolveMofangConfig();
    if (!exists) throw new Error(`默认位置没有找到墨坊 config.json（预期 ${file}）；请先启动一次墨坊或手动指定文件`);
    return { target, path: file };
  }
  throw new Error('无效的写入目标');
}

async function selectModel(model, selected) {
  if (stopping || probing || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待检测完成后选择模型');
  if (typeof selected !== 'boolean' || !models.some(m => m.id === model)) throw new Error('无效的模型选择');
  const excluded = new Set(settings.excludedModels || []);
  if (selected) excluded.delete(model); else excluded.add(model);
  const next = { ...settings, excludedModels: [...excluded] };
  await atomicWrite(settingsFile, JSON.stringify(next));
  settings = next; update({ excludedModels: next.excludedModels });
  return { excludedModels: next.excludedModels };
}

async function importModels(selectedFile) {
  if (stopping || probing || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待读取和检测完成后导入');
  if (state.target === 'dsh') {
    // profile 可能是应用启动后才出现的（先开 DSH 再开 MoBridge 之外的顺序），
    // 每次写入前重扫一次，不把一份过期目录当成事实。
    dshProfiles = await listDshProfiles(dshHome);
    update({ dsh: dshAttachment() });
    const sync = await syncPublished();
    if (sync.error) throw new Error(sync.error);
    return sync;
  }
  if (selectedFile !== undefined) {
    await validateModelsFile(selectedFile);
    // 换配置文件之前，先从旧文件里摘掉自己的条目——不然它们会永远留在那儿没人认领。
    if (modelsFile && modelsFile !== selectedFile && await fs.stat(modelsFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
      const cleanup = await syncPublished([]);
      if (cleanup.error) throw new Error(cleanup.error);
    }
    const nextSettings = { ...settings, workBuddyModelsFile: selectedFile };
    await atomicWrite(settingsFile, JSON.stringify(nextSettings));
    settings = nextSettings; modelsFile = selectedFile; update({ modelsFile });
  }
  const sync = await syncPublished();
  if (sync.error) throw new Error(sync.error);
  return sync;
}

// 移除配置：写入空集合 = 只摘掉本插件写入的条目；文件里其它工具的配置原样保留。
// 幂等：本来就没有自己的条目时 writePublished 不会改文件（changed=false）。
async function removeImported() {
  const sync = await syncPublished([]);
  if (sync.error) throw new Error(sync.error);
  return sync;
}

// ── AtomCode ─────────────────────────────────────────────────────────────
// 与日日新相反：这一路的模型必须经本机转发口出去，所以写入目标是「本机地址 + 本机口令」，
// 而上游凭据只留在服务进程里。
const acClient = {
  // 写进客户端配置的 id 一律用展示名（`AC · xxx`），和 OpenCode 那一路保持一致：
  // 客户端把 id 原样发回来，转发口去掉前缀再转给上游。若这里写上游真名，
  // 客户端发回来的就是真名，两套写法在同一份配置里并存只会增加对不上的机会。
  idOf: (model: { id: string }) => model.id,
  labelOf: (model: { id: string }) => model.id,
};
async function acSyncState() {
  acFound = await detectAtomcode();
  acAuth = await readAuth();
  acGateway = await readGateway(dataDir);
  update({ atomcode: acSnapshot() });
  return acSnapshot();
}
async function acRefreshCatalog(force = false) {
  acCatalog = await acLoadCatalog(acToken(), { force, home: atomcodeHome() });
  const known = acModels().map(model => model.upstream);
  const saved = await acReadSelection(dataDir);
  acSelection = (saved === null ? known : saved).filter(id => known.includes(id));
  acAuth = await readAuth();
  update({ atomcode: acSnapshot() });
  return acSnapshot();
}
async function writeAtomcode(target, models) {
  if (!acBridge) throw new Error('AtomCode 转发口未启动，请重启服务后重试');
  const endpoint = `${acBridge.endpoint}/v1`;
  if (target === 'dsh')
    return syncDshProvider(dshProfiles, models, endpoint, acBridge.key, {
      allowEmpty: true, providerId: 'mobridge-atomcode', displayName: '墨桥 · AtomCode', ...acClient,
    });
  if (target === 'mofang') {
    mofangInfo = await describeMofang(mofangOptions());
    const { file } = await resolveMofangConfig(mofangOptions());
    return syncMofangProvider(models, endpoint, acBridge.key, {
      file, allowEmpty: true, providerId: 'mobridge-atomcode',
      owner: SOURCE_OWNERS.atomcode, name: '墨桥 · AtomCode', ...acClient,
    });
  }
  if (!modelsFile) throw new Error('未找到有效的 WorkBuddy 配置，请先导入并选择 models.json');
  return syncModels(modelsFile, models, `${endpoint}/chat/completions`, acBridge.key, {
    allowEmpty: true, requireExisting: process.platform === 'win32',
    owner: SOURCE_OWNERS.atomcode, clientId: model => model.id,
  });
}
async function acImport() {
  const chosen = acModels().filter(model => acSelection.includes(model.upstream));
  const active = state.target || 'workbuddy';
  const result = await writeAtomcode(active, chosen);
  update({ atomcode: acSnapshot() });
  return { ...result, target: active };
}
async function acRemove() {
  const active = state.target || 'workbuddy';
  const result = await writeAtomcode(active, []);
  update({ atomcode: acSnapshot() });
  return { ...result, target: active };
}

// ── 日日新（SenseNova）────────────────────────────────────────────────────
// 它与 OpenCode 走的是两套完全不同的链路：OpenCode 经本机转发口，日日新直连上游。
// 但「写进哪个目标、只动自己的条目」这套规矩是一致的，所以复用同一批写入器，
// 靠 owner / providerId 区分来源，三方写同一份 models.json 也互不擦除。
const snClient = {
  // 发给上游的必须是真名；带前缀的名字只用于展示。
  idOf: (model: { upstream: string }) => model.upstream,
  labelOf: (model: { id: string }) => model.id,
};
async function snSyncState() {
  snKey = await snReadKey(dataDir);
  snBase = await snReadApiBase(dataDir);
  const saved = await snReadSelection(dataDir);
  const known = snModels().map(model => model.upstream);
  snSelection = (saved === null ? known : saved).filter(id => known.includes(id));
  update({ sensenova: snSnapshot() });
  return snSnapshot();
}
async function writeSensenova(target, models) {
  if (!snKey) throw new Error('请先填写日日新 API Key');
  if (target === 'dsh')
    return syncDshProvider(dshProfiles, models, snBase.apiBase, snKey, {
      allowEmpty: true, providerId: 'mobridge-sensenova', displayName: '墨桥 · 日日新', ...snClient,
    });
  if (target === 'mofang') {
    mofangInfo = await describeMofang(mofangOptions());
    const { file } = await resolveMofangConfig(mofangOptions());
    return syncMofangProvider(models, snBase.apiBase, snKey, {
      file, allowEmpty: true, providerId: 'mobridge-sensenova',
      owner: SOURCE_OWNERS.sensenova, name: '墨桥 · 日日新', ...snClient,
    });
  }
  if (!modelsFile) throw new Error('未找到有效的 WorkBuddy 配置，请先导入并选择 models.json');
  return syncModels(modelsFile, models, `${snBase.apiBase}/chat/completions`, snKey, {
    allowEmpty: true, requireExisting: process.platform === 'win32',
    owner: SOURCE_OWNERS.sensenova, clientId: model => model.id,
  });
}
async function snImport() {
  if (!snKey) throw new Error('请先填写日日新 API Key');
  const chosen = snModels().filter(model => snSelection.includes(model.upstream));
  const active = state.target || 'workbuddy';
  const result = await writeSensenova(active, chosen);
  snLastWrite = { time: new Date().toISOString(), target: active, count: result.count ?? chosen.length, changed: result.changed !== false };
  update({ sensenova: snSnapshot() });
  return { ...result, target: active };
}
async function snRemove() {
  const active = state.target || 'workbuddy';
  const result = await writeSensenova(active, []);
  if (result.changed !== false) snLastWrite = null;
  update({ sensenova: snSnapshot() });
  return { ...result, target: active };
}
async function snValidateAction() {
  if (!snKey) throw new Error('尚未配置 API Key，请先填写');
  const result = await snValidate(snKey, { baseUrl: snBase.apiBase, preferred: SN_PROBE_MODEL, timeoutMs: serviceSettings.sensenovaTimeoutMs });
  snValidation = { ...result, time: new Date().toISOString() };
  // 鉴权通过就把每个模型都真跑一遍：账号能连不等于每个模型都可用。
  if (result.ok) snProbeResults = await snProbeAll(snKey, snModels(), { baseUrl: snBase.apiBase, timeoutMs: serviceSettings.sensenovaTimeoutMs });
  update({ sensenova: snSnapshot() });
  return { ...result, available: Object.values(snProbeResults).filter((item: any) => item?.ok === true).length };
}
async function snProbeAction(only) {
  if (!snKey) throw new Error('尚未配置 API Key，请先填写');
  const ids = Array.isArray(only) && only.length ? only : null;
  snProbeResults = { ...snProbeResults, ...await snProbeAll(snKey, snModels(), { baseUrl: snBase.apiBase, only: ids, timeoutMs: serviceSettings.sensenovaTimeoutMs }) };
  update({ sensenova: snSnapshot() });
  return { available: Object.values(snProbeResults).filter((item: any) => item?.ok === true).length };
}

// 切换写入目标：旧目标先摘掉自己的条目（否则两处都会指向这个本机转发口，
// 关掉 MoBridge 后留下两份死配置），再持久化选择、立刻把当前勾选写进新目标。
async function setTarget(next) {
  if (!['workbuddy', 'dsh', 'mofang'].includes(next)) throw new Error('无效的写入目标');
  // 后台检测在跑时也允许切目标：一整轮探测最坏要几分钟（60s × 12 个模型 / 并发 3），
  // 让用户在这期间点不动「写入目标」没有任何道理。
  // 并发安全靠两点保证：① 所有写入都排在 syncWrites 这条串行队列上；
  // ② 先把内存里的目标切过去，再清理旧目标——这样清理期间排进来的写入会落到新目标，
  //    而不会在清理之后又把条目写回旧目标。
  if (stopping || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待读取和检测完成');
  if (state.target === next) return { target: next, changed: false, count: 0 };
  dshProfiles = await listDshProfiles(dshHome);
  if (next === 'dsh' && !dshProfiles.length) throw new Error('未检测到 DSH 配置；请先启动一次 DeepSeek Harness（~/.dsh/profiles）');
  if (next === 'mofang') {
    mofangInfo = await describeMofang(mofangOptions());
    if (!mofangInfo.exists) throw new Error('未检测到墨坊配置；请先启动一次墨坊（~/.mofang/config.json）');
  }
  // 等排队中的自动写入落完再清理：否则一次轮末同步可能在切换后又写回旧目标。
  await syncWrites;
  const previous = state.target || 'workbuddy';
  state = { ...state, target: next };
  try {
    if (previous === 'dsh' && dshProfiles.length) await syncDshProvider(dshProfiles, [], endpoint, key, { allowEmpty: true });
    else if (previous === 'mofang' && mofangInfo.exists) await writePublished('mofang', []);
    else if (previous === 'workbuddy' && modelsFile) await writePublished('workbuddy', []);
  } catch (error) {
    // 清理失败要退回去：内存目标不能比落盘的设置跑在前面。
    state = { ...state, target: previous };
    throw new Error('清理原写入目标失败：' + error.message);
  }
  const updated = { ...settings, target: next };
  await atomicWrite(settingsFile, JSON.stringify(updated));
  settings = updated;
  mofangInfo = await describeMofang(mofangOptions());
  update({ target: next, dsh: dshAttachment(), mofang: mofangAttachment() });
  await refreshTargets();
  const sync = await syncPublished();
  if (sync.error) throw new Error(sync.error);
  return { ...sync, target: next };
}

// ── 设置 ─────────────────────────────────────────────────────────────────
// 面板只发改动的那几个字段，这里合并进整份 settings.json 再统一落盘：
// 一次只调超时的请求不该把 target / excludedModels 一起抹掉。
// 不拦"检测中"——超时和并发都是每次取用现读，下一轮自然按新值走。
async function saveSettings(patch) {
  const picked = pickKnownKeys(patch);
  // 路径项不进 normalizeSettings（那是数值/布尔旋钮的归一器），单独取值、校验、落盘。
  const pathPicked = pickPathPatch(patch);
  if (!Object.keys(picked).length && !Object.keys(pathPicked).length) throw new Error('没有可保存的设置项');

  // 只处理「真的变了」的路径；逐个校验，找不到就直接报错，绝不静默回退到默认目录。
  const changedTargets: TargetKey[] = [];
  for (const [key, value] of Object.entries(pathPicked) as Array<[PathKey, string | null]>) {
    const before = (settings[key] as string | undefined) || null;
    if ((value || null) === before) continue;
    if (value) await validateTargetPath(PATH_TARGET[key], value);
    changedTargets.push(PATH_TARGET[key]);
  }

  const next = normalizeSettings({ ...serviceSettings, ...picked });
  const merged = { ...settings, ...next };
  for (const [key, value] of Object.entries(pathPicked) as Array<[PathKey, string | null]>) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  // 顺序有讲究：先用旧位置清理 → 再切运行时 → 最后落盘。
  // 任何一步失败都回滚运行时快照，绝不留下「设置已落盘但内存还指向旧路径」的错位。
  const snapshot = { modelsFile, dshHome, dshProfiles, mofangInfo };
  if (changedTargets.length) {
    await cleanupOldPaths(changedTargets);
    try {
      await applyTargetPaths(merged);
      await atomicWrite(settingsFile, JSON.stringify(merged));
    } catch (error) {
      ({ modelsFile, dshHome, dshProfiles, mofangInfo } = snapshot);
      update({ modelsFile, dsh: dshAttachment(), mofang: mofangAttachment() });
      throw error;
    }
  } else {
    await atomicWrite(settingsFile, JSON.stringify(merged));
  }

  // 缓存的三个时长要立刻生效：用户改完去看"为什么它还是缓存"是说不通的。
  probeCache.configure({
    okTtlMinutes: next.probeCacheMinutes,
    transientTtlMinutes: next.transientTtlMinutes,
    rejectTtlMinutes: next.rejectTtlMinutes,
  });
  serviceSettings = next;
  settings = merged;
  const targetPaths = await describeTargetPaths();
  update({ settings: next, targetPaths });
  if (changedTargets.length) {
    await refreshTargets();
    // 改的就是当前目标时，把现有可用模型立刻写进新位置，别让用户以为改完没生效。
    if (changedTargets.includes((state.target || 'workbuddy') as TargetKey)) await syncPublished();
  }
  log.write(`${new Date().toISOString()} 设置已更新：${JSON.stringify({ ...picked, ...pathPicked })}\n`);
  return { settings: next, targetPaths, changedTargets: changedTargets.map(t => TARGET_LABEL[t]) };
}

// 清空判定缓存：只丢"结论"，不动当前这一轮的检测结果（那是刚量出来的事实）。
async function clearProbeCache() {
  if (probing) throw new Error('检测进行中，请等这一轮结束后再清空判定缓存');
  const removed = await probeCache.clear();
  update({ cacheEntries: 0 });
  log.write(`${new Date().toISOString()} 判定缓存已清空（${removed} 条）\n`);
  return { removed, cacheEntries: 0 };
}

// 收摊时每个环节都可能有"永远等不到"的情况：探测里的上游连接、运行时子进程、
// 半截的磁盘写入。给它们各自一个上限，超时就往下走——退出这件事不能无限期挂着，
// 主进程那边等不到就会强杀，结果一样只是更难看。
const settle = (work, ms) => Promise.race([
  Promise.resolve(work).catch(() => {}),
  new Promise(resolve => setTimeout(resolve, ms)),
]);

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  probeAbort.abort();
  server?.abortAll?.(); server?.closeAllConnections();
  server?.removeAllListeners('request');
  // 收摊期间进来的请求直接 503，而不是挂在半死的服务上。
  server?.on('request', (_req, res) => { res.writeHead(503); res.end(); });
  // 退出时**不动**客户端的配置文件。
  // 早先这里会 syncPublished([]) 把条目摘掉，那是把"退出"当成了"移除"：
  // 用户点一下窗口的 ×，客户端里刚配好的模型就集体消失，属于没有任何提示的数据副作用。
  // 摘条目只应该由「移除配置」这个显式动作触发（server 的 /admin/remove）。
  try { acBridge?.close(); } catch { /* 已关闭 */ }
  if (code === 0) update({ phase: 'stopped', message: '已停止' });
  await settle(runtime?.stop(), 2500);
  await settle(refreshing, 1500);
  await settle(probeTask, 2000);
  await settle(syncWrites, 2000);
  await settle(probeCache.flush(), 1500);
  await settle(statusWrites, 1500);
  log.end(); await fs.unlink(lockFile).catch(() => {});
  server?.close();
  process.exit(code);
}
// 被 Electron 强杀时也要有机会收摊：IPC 断开与会话结束都当作退出信号。
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', () => shutdown());
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('uncaughtException', e => { update({ phase: 'error', message: e.message }); shutdown(1); });
process.on('unhandledRejection', e => { update({ phase: 'error', message: String(e?.message || e) }); shutdown(1); });
try {
  update({ phase: 'starting' });
  const cached = await probeCache.load();
  // 冷启动（缓存里一条新鲜判定都没有）先清一次：上一次异常退出可能把自己的条目留在了配置里。
  // 热启动跳过这一步——下面用到缓存判定之后会立刻把同一份清单写回去，先清后写只会平白多两次备份。
  if (!cached) await syncPublished([]);
  let startupProxyEnv;
  try { startupProxyEnv = await systemProxyEnvironment(state.useSystemProxy); }
  catch (error) {
    // 全新安装默认跟随系统代理，但一台根本没配手动代理的机器也必须能下载。
    // 明确保存过"开"的用户例外：那是用户的选择，出错就该报出来。
    if (settings.useSystemProxy === true) throw error;
    startupProxyEnv = await systemProxyEnvironment(false);
    update({ useSystemProxy: false });
    log.write(`${new Date().toISOString()} 未检测到可用的系统代理，首次下载改为直连：${error.message}\n`);
  }
  binary = await findRuntime(dataDir, message => update({ message }), {
    proxyEnv: startupProxyEnv,
    onProxyFallback: async () => {
      // 自动探测出来的代理坏掉了：把开关也落成"关"，让 OpenCode 之后的出站别再用它。
      if (settings.useSystemProxy !== true) {
        startupProxyEnv = await systemProxyEnvironment(false);
        update({ useSystemProxy: false });
      }
    },
    log: message => log.write(`${new Date().toISOString()} ${message}\n`),
  });
  server = createServer({ server, key, selectModel, backend: { complete: (...args) => runtime.backend.complete(...args) }, getModels: publishedModels, refresh: readModels, importModels, removeImported, findConfig, setSystemProxy, setTarget,
    inspectTargets: async () => { await refreshTargets(); return state.targets },
    saveSettings, autoLocatePath, clearCache: clearProbeCache,
    sensenova: {
      saveKey: async value => { const keyMask = await snSaveKey(dataDir, value); snValidation = null; snProbeResults = {}; await snSyncState(); return { keyMask } },
      clearKey: async () => { const removed = await snClearKey(dataDir); snValidation = null; snProbeResults = {}; snLastWrite = null; await snSyncState(); return { removed } },
      saveBase: async value => { const saved = await snSaveApiBase(dataDir, value); snValidation = null; snProbeResults = {}; await snSyncState(); return saved },
      resetBase: async () => { const saved = await snSaveApiBase(dataDir, ''); snValidation = null; snProbeResults = {}; await snSyncState(); return saved },
      validate: snValidateAction,
      probe: snProbeAction,
      selection: async value => { await snSaveSelection(dataDir, value?.ids); await snSyncState(); return { selection: snSelection, excluded: snModels().map(m => m.upstream).filter(id => !snSelection.includes(id)) } },
      import: snImport,
      remove: snRemove,
    },
    atomcode: {
      detect: async () => { await acSyncState(); return acSnapshot() },
      install: async () => {
        const result = await runInstall();
        await acSyncState();
        return { ...result, ...acSnapshot() };
      },
      login: async () => {
        const found = acFound.installed ? { path: acFound.path } : await detectAtomcode();
        const result = await runLogin(found.path);
        await acSyncState();
        acClearCache();
        await acRefreshCatalog(true);
        return { ...result, ...acSnapshot() };
      },
      refresh: async () => { acClearCache(); await acRefreshCatalog(true); return acSnapshot() },
      'save-gateway': async value => { acGateway = await saveGateway(dataDir, value); update({ atomcode: acSnapshot() }); return acGateway },
      'reset-gateway': async () => { acGateway = await saveGateway(dataDir, ''); update({ atomcode: acSnapshot() }); return acGateway },
      selection: async value => { acSelection = await acSaveSelection(dataDir, value?.ids); update({ atomcode: acSnapshot() }); return { selection: acSelection } },
      import: acImport,
      remove: acRemove,
    },
    status: () => state, probe: startProbes, onResult: record, onActivity: noteActivity });
  // AtomCode 转发口：独立端口、独立口令，错了也不影响主转发口。
  try {
    acBridge = await startAtomcodeBridge({
      dataDir,
      port: atomcodePort,
      getState: () => ({ models: acModels(), token: acToken(), gateway: acGateway.gateway }),
    });
  } catch (error) {
    acBridge = null;
    update({ atomcode: { ...acSnapshot(), bridgeError: (error as Error).message } });
    log(`AtomCode 转发口启动失败：${(error as Error).message}`);
  }
  await acRefreshCatalog(false).catch(() => {});
  update({ atomcode: acSnapshot() });
  update({ message: '正在启动隔离模型服务' });
  runtime = attachTranslator(await startBackend(binary, dataDir, log, startupProxyEnv));
  watchRuntime(runtime);
  // 确认运行的是本产品要的专用 agent，而不是用户自己的构建 agent。
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'mobridge')) throw new Error('Dedicated approval-gated agent missing');
  await refresh();
  // 先把三个写入目标的体检结果算出来：页面第一次渲染就要知道「移除配置」能不能点。
  await refreshTargets();
  update({ cacheEntries: probeCache.size() });
  // 启动即整轮检测（默认开）：「打开就能用」靠的就是这一步。
  // 关掉之后仍然沿用缓存里的判定——否则每次都从零开始，用户还得手动点一次"检测全部"。
  const round = serviceSettings.autoProbeOnStart ? startProbes(undefined, true, true) : { reused: adoptCachedModels(models), probing: 0 };
  // 采用缓存判定之后立刻同步一次：热启动时模型几秒内就回到 WorkBuddy 里，
  // 不必等这一轮真正要探测的那几个跑完（轮末还会再同步一次）。
  if (!stopping && round?.reused) await syncPublished();
  if (!stopping && !serviceSettings.autoProbeOnStart)
    log.write(`${new Date().toISOString()} 已关闭启动自动检测，仅采用 ${round?.reused ?? 0} 条缓存判定\n`);
  console.log(`MoBridge ready at ${endpoint}; ${models.length} free models; probe cache hit ${round?.reused ?? 0}, probing ${round?.probing ?? 0}`);
} catch (e) { update({ phase: 'error', message: e.message }); if (!runtime) await shutdown(1); }
