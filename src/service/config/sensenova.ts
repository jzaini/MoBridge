import fs from 'node:fs/promises';
import path from 'node:path';

// 日日新（SenseNova）接入的静态事实。
//
// 官方**没有** /v1/models 这类动态目录接口，可用模型以文档「模型总览」的表格形式给出。
// 所以这里的清单是人工核对过的官方文档快照 —— 不假装它是实时拉取的。
// 约定：context 为 null 表示官方未公开数值，界面显示「—」，绝不编造。
export const API_BASE = 'https://token.sensenova.cn/v1';
export const DEFAULT_PROBE_MODEL = 'sensenova-6.8-flash';
export const KEYS_URL = 'https://platform.sensenova.cn/console/keys';
export const DOCS_URL = 'https://platform.sensenova.cn/docs';
// 外链白名单：页面里「打开管理页 / 官方文档」只允许这些域名，由主进程开系统浏览器。
export const EXTERNAL_HOSTS = ['platform.sensenova.cn', 'token.sensenova.cn'];
export const CONTEXT_UNKNOWN = '官方未公开该模型的上下文窗口数值';

const CAP = {
  multimodal: '多模态', agent: '智能体', vision: '视觉',
  reasoning: '推理', imageGen: '图像生成', text: '对话', open: '开源',
} as const;

export interface SensenovaModel {
  /** 客户端可见 id（写入 WorkBuddy / DSH 时展示的名字）。 */
  id: string;
  /** 真正发给上游的 model 名。 */
  upstream: string;
  name: string;
  kind: 'chat' | 'image';
  context: number | null;
  images: boolean;
  caps: string[];
  note: string;
  /** 图像生成模型不走 /chat/completions，不参与文本可用性检测。 */
  chatProbe?: boolean;
}

// 数据来源：官方文档「模型总览」+ 发布说明（6.8 Flash 原生 256K，Flash-Lite 128K）。
// images 取保守值：只有明确主打多模态的 6.8 Flash 标 true，避免客户端拼图文数组后命中 400。
const MODELS: SensenovaModel[] = [
  { id: 'SN · sensenova-6.8-flash', upstream: 'sensenova-6.8-flash', name: 'SenseNova 6.8 Flash', kind: 'chat', context: 256000, images: true, caps: [CAP.multimodal, CAP.agent],
    note: '6.8 系列旗舰多模态智能体，原生 256K 上下文，擅长办公 / 设计 / 数据分析。' },
  { id: 'SN · sensenova-6.8-flash-lite', upstream: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', kind: 'chat', context: 131072, images: false, caps: [CAP.multimodal],
    note: '轻量多模态，享有专属积分池（5h 窗口 60k / 周 600k）。按纯文本接入更稳。' },
  { id: 'SN · sensenova-u1.5-lite', upstream: 'sensenova-u1.5-lite', name: 'SenseNova U1.5 Lite', kind: 'image', context: null, images: true, caps: [CAP.imageGen], chatProbe: false,
    note: 'U1.5 图像创作；走 /images/generations，不参与文本可用性检测。' },
  { id: 'SN · sensenova-u1.5-fast', upstream: 'sensenova-u1.5-fast', name: 'SenseNova U1.5 Fast', kind: 'image', context: null, images: true, caps: [CAP.imageGen], chatProbe: false,
    note: 'U1.5 图像创作加速版；走 /images/generations，不参与文本可用性检测。' },
  { id: 'SN · deepseek-flash', upstream: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', kind: 'chat', context: null, images: false, caps: [CAP.text, CAP.reasoning],
    note: 'DeepSeek V4.1 Flash，通用对话与推理。' },
  { id: 'SN · deepseek-v4-flash', upstream: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', kind: 'chat', context: null, images: false, caps: [CAP.text],
    note: 'DeepSeek V4 Flash，轻量通用对话。' },
  { id: 'SN · glm-5.3', upstream: 'glm-5.3', name: 'GLM-5.3', kind: 'chat', context: null, images: false, caps: [CAP.text, CAP.reasoning],
    note: '智谱 GLM-5.3 旗舰模型。' },
  { id: 'SN · glm-5.2', upstream: 'glm-5.2', name: 'GLM-5.2', kind: 'chat', context: null, images: false, caps: [CAP.text, CAP.open],
    note: '智谱 GLM-5.2 开源模型。' },
  { id: 'SN · kimi-k3', upstream: 'kimi-k3', name: 'Kimi K3', kind: 'chat', context: null, images: false, caps: [CAP.multimodal, CAP.agent, CAP.open],
    note: 'Kimi K3 开源多模态 Agent（官方标注多模态，按纯文本接入更稳）。' },
];

export function allModels(): SensenovaModel[] {
  // 返回副本：调用方改动不该影响这份静态清单。
  return MODELS.map(model => ({ ...model, caps: [...model.caps] }));
}
export function chatModels(): SensenovaModel[] {
  return allModels().filter(model => model.chatProbe !== false);
}
export function modelByUpstream(upstream: string) {
  return MODELS.find(model => model.upstream === upstream) ?? null;
}

/** 纯函数：只放行白名单域名的 https 链接。 */
export function allowedExternal(raw: unknown): string | null {
  let url: URL;
  try { url = new URL(String(raw ?? '')); } catch { return null; }
  if (url.protocol !== 'https:' || !EXTERNAL_HOSTS.includes(url.hostname)) return null;
  return url.toString();
}

// ── 密钥存储 ────────────────────────────────────────────────────────────
// 只存在墨桥自己的数据目录里，0600；永不下发渲染层，页面只拿到掩码。
export function keyFile(dataDir: string) {
  return path.join(dataDir, 'sensenova.key');
}
export function settingsFile(dataDir: string) {
  return path.join(dataDir, 'sensenova.json');
}
export async function readKey(dataDir: string): Promise<string | null> {
  const value = await fs.readFile(keyFile(dataDir), 'utf8').catch(() => null);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
export async function saveKey(dataDir: string, value: unknown): Promise<string | null> {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('API Key 不能为空');
  // 明显不像 key 的输入当场拒绝，比等一次 401 再猜要清楚得多。
  if (key.length < 16 || /\s/.test(key)) throw new Error('API Key 格式不对：不应包含空白，且长度至少 16 位');
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(keyFile(dataDir), key + '\n', { mode: 0o600 });
  return maskKey(key);
}
export async function clearKey(dataDir: string) {
  const existed = await fs.stat(keyFile(dataDir)).then(() => true, () => false);
  await fs.unlink(keyFile(dataDir)).catch(() => {});
  return existed;
}
export function maskKey(key: string | null): string | null {
  if (!key) return null;
  if (key.length <= 10) return key.slice(0, 2) + '***';
  return key.slice(0, 6) + '***' + key.slice(-4);
}

/** 接口地址：默认官方固定地址，允许改成自己的反向代理 / 兼容端点。 */
export async function readApiBase(dataDir: string): Promise<{ apiBase: string; custom: boolean }> {
  const text = await fs.readFile(settingsFile(dataDir), 'utf8').catch(() => null);
  if (!text) return { apiBase: API_BASE, custom: false };
  try {
    const saved = JSON.parse(text) as { apiBase?: string };
    if (typeof saved.apiBase === 'string' && saved.apiBase.trim())
      return { apiBase: normalizeBase(saved.apiBase), custom: true };
  } catch { /* 坏文件按默认处理，不让它挡住整页 */ }
  return { apiBase: API_BASE, custom: false };
}
export async function saveApiBase(dataDir: string, value: unknown) {
  const raw = String(value ?? '').trim();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!raw) {
    await fs.unlink(settingsFile(dataDir)).catch(() => {});
    return { apiBase: API_BASE, custom: false };
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('接口地址不是合法 URL'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('接口地址必须是 http(s)');
  const apiBase = normalizeBase(raw);
  await fs.writeFile(settingsFile(dataDir), JSON.stringify({ apiBase }) + '\n', { mode: 0o600 });
  return { apiBase, custom: true };
}
export function normalizeBase(value: string) {
  const trimmed = String(value || API_BASE).trim().replace(/\/+$/, '');
  return trimmed.replace(/\/chat\/completions$/i, '');
}

/** 勾选记录：只存 upstream id，写入时再按清单过滤一遍。 */
export function selectionFile(dataDir: string) {
  return path.join(dataDir, 'sensenova-selection.json');
}
export async function readSelection(dataDir: string): Promise<string[] | null> {
  const text = await fs.readFile(selectionFile(dataDir), 'utf8').catch(() => null);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    const known = new Set(MODELS.map(model => model.upstream));
    return parsed.filter((id): id is string => typeof id === 'string' && known.has(id));
  } catch { return null; }
}
export async function saveSelection(dataDir: string, ids: unknown) {
  const known = new Set(MODELS.map(model => model.upstream));
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(selectionFile(dataDir), JSON.stringify(list) + '\n', { mode: 0o600 });
  return list;
}
