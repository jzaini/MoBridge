// 写入目标的配置文件/目录位置：预设规则之上的「覆写层」。
//
// 三个目标原本各自按固定目录或环境变量找配置（~/.workbuddy、~/.dsh、~/.mofang），
// 用户把配置目录搬到别处就写不进去，而且失败时页面不会说明「写到哪了」。
// 这里把「用户指定值」收成一份可校验、可落盘的纯数据；各 config 模块只接受传入的
// saved 值，不自己去读 settings.json —— 保持路径解析函数可单测。
//
// 优先级：设置里指定的值 > 环境变量 > 内置默认目录。找不到就明确报错，
// 绝不静默回退到默认位置（静默回退 = 把模型写进用户根本不用的那份配置）。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { validateModelsFile } from './workbuddy-config.ts';
// 键名/形态是三方共用的纯常量，放 shared；这里只留校验与归一化。
import {
  TARGET_PATH_KEYS as PATH_KEYS, TARGET_PATH_KIND as PATH_KIND, PATH_TARGET,
  type TargetKey, type TargetPathKey as PathKey,
} from '../../shared/target-path-keys.ts';
export {
  TARGET_PATH_KEYS, TARGET_PATH_KEY as TARGET_PATH, PATH_TARGET,
  TARGET_PATH_KIND, TARGET_PATH_LABEL as TARGET_LABEL,
  type TargetKey,
} from '../../shared/target-path-keys.ts';
export type { TargetPathKey as PathKey } from '../../shared/target-path-keys.ts';

export function isPathKey(key: string): key is PathKey {
  return (PATH_KEYS as readonly string[]).includes(key);
}

/**
 * 从设置 patch 里挑出路径项。
 * 空串 / null / 非字符串按「恢复默认」处理（用 null 标记删除该键）。
 * 路径来自系统文件对话框，但仍按不可信输入处理：拒绝超长与 NUL。
 */
export function pickPathPatch(patch: unknown): Partial<Record<PathKey, string | null>> {
  const source = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch as Record<string, unknown> : {};
  const out: Partial<Record<PathKey, string | null>> = {};
  for (const key of PATH_KEYS) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (raw === null || raw === undefined || raw === '') { out[key] = null; continue; }
    if (typeof raw !== 'string') throw new Error(`配置路径必须是文本：${key}`);
    const value = raw.trim();
    if (value.length > 4096 || value.includes('\0')) throw new Error(`配置路径不合法：${key}`);
    out[key] = value || null;
  }
  return out;
}

/**
 * 纯本地的 WorkBuddy 配置定位：扫常见位置 + Windows 各盘符的用户目录。
 *
 * 刻意**不**复用 config-finder 的跨盘模型查找——那条路要 OpenCode runtime 起一个只读
 * 模型会话去 glob，首启或 runtime 忙时能挂几分钟。设置面板的「自动查找」必须点了就有结果，
 * 所以这里只做毫秒级的本地 stat；真放到很偏的目录时，用户还有「更改…」这条路。
 */
export async function locateWorkbuddyFile(options: { env?: Record<string, string | undefined>; home?: string; scanDrives?: boolean } = {}): Promise<string | null> {
  const { env = process.env, home = os.homedir(), scanDrives = true } = options;
  const roots = [home, env.APPDATA, env.LOCALAPPDATA, env.WORKBUDDY_CONFIG_DIR].filter(Boolean) as string[];
  const candidates = new Set<string>();
  for (const root of roots) {
    candidates.add(path.join(root, '.workbuddy', 'models.json'));
    candidates.add(path.join(root, 'WorkBuddy', 'models.json'));
    candidates.add(path.join(root, 'models.json'));
  }
  if (scanDrives && process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = `${letter}:\\`;
      if (!(await fs.stat(root).then(s => s.isDirectory(), () => false))) continue;
      candidates.add(path.join(root, '.workbuddy', 'models.json'));
      const users = path.join(root, 'Users');
      const entries = await fs.readdir(users, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) candidates.add(path.join(users, entry.name, '.workbuddy', 'models.json'));
      }
    }
  }
  for (const file of candidates) {
    try { await validateModelsFile(file); return file; } catch { /* 不是有效配置，继续找 */ }
  }
  return null;
}

/**
 * 保存前校验：找不到或格式不对就明确报错，不让用户以为改成功了。
 * 注意不在这里「自动创建」配置文件——那会凭空多出一份应用根本不读的文件。
 */
export async function validateTargetPath(target: TargetKey, value: string): Promise<void> {
  const file = path.resolve(value);
  if (PATH_KIND[target] === 'directory') {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`DSH 目录不存在或不是文件夹：${file}`);
    const profiles = path.join(file, 'profiles');
    const pstat = await fs.stat(profiles).catch(() => null);
    if (!pstat?.isDirectory()) throw new Error(`该目录下没有 profiles/，DSH 不会读取它：${file}`);
    return;
  }
  if (target === 'workbuddy') { await validateModelsFile(file); return; }
  // 墨坊 config.json：必须已存在、可解析、且带 providers 数组。
  if (target === 'mofang') {
    const text = await fs.readFile(file, 'utf8').catch(() => { throw new Error(`墨坊配置文件读不到：${file}`); });
    let doc: unknown;
    try { doc = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch { throw new Error(`墨坊配置文件不是合法 JSON：${file}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`墨坊配置文件格式不对（应为对象）：${file}`);
    if (!Array.isArray((doc as { providers?: unknown }).providers)) throw new Error(`墨坊配置文件里没有 providers 数组：${file}`);
    return;
  }
  // Qoder settings.json：必须已存在且可解析为对象。
  if (target === 'qoder') {
    const text = await fs.readFile(file, 'utf8').catch(() => { throw new Error(`Qoder settings.json 读不到：${file}`); });
    let doc: unknown;
    try { doc = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch { throw new Error(`Qoder settings.json 不是合法 JSON：${file}`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`Qoder settings.json 格式不对（应为对象）：${file}`);
    return;
  }
  // Trae state.vscdb：必须是 SQLite 数据库（16 字节文件头固定为 "SQLite format 3\0"）。
  const header = Buffer.alloc(16);
  const handle = await fs.open(file, 'r').catch(() => { throw new Error(`Trae 数据库读不到：${file}`); });
  try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
  if (header.toString('utf8', 0, 15) !== 'SQLite format 3') throw new Error(`不是 SQLite 数据库文件：${file}`);
}
