// 写入位置配置的键名与形态：主进程、服务层、渲染层三方共用。
// 这里只有纯常量，绝不引入 node:fs —— 渲染层也要安全引用。
// 校验与归一化逻辑留在 src/service/config/target-paths.ts。

export type TargetKey = 'workbuddy' | 'dsh' | 'mofang'

/** settings.json 里的三个覆写键。workBuddyModelsFile 是既有字段，沿用不改名。 */
export const TARGET_PATH_KEYS = ['workBuddyModelsFile', 'dshHome', 'mofangConfigFile'] as const
export type TargetPathKey = typeof TARGET_PATH_KEYS[number]

export const TARGET_PATH_KEY: Record<TargetKey, TargetPathKey> = {
  workbuddy: 'workBuddyModelsFile',
  dsh: 'dshHome',
  mofang: 'mofangConfigFile',
};

export const PATH_TARGET: Record<TargetPathKey, TargetKey> = {
  workBuddyModelsFile: 'workbuddy',
  dshHome: 'dsh',
  mofangConfigFile: 'mofang',
};

/** WorkBuddy / 墨坊选文件，DSH 选目录（它下面有 profiles/）。 */
export const TARGET_PATH_KIND: Record<TargetKey, 'file' | 'directory'> = {
  workbuddy: 'file',
  dsh: 'directory',
  mofang: 'file',
};

export const TARGET_PATH_LABEL: Record<TargetKey, string> = {
  workbuddy: 'WorkBuddy',
  dsh: 'DSH',
  mofang: '墨坊',
};
