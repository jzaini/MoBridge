import type { ServiceState, SyncState, TargetInspection } from '@shared/types'

// 写入目标的展示口径：目标名字、写到哪里、为什么写不进去。
// 页面标题、状态面板、环境弹窗、确认弹窗都用这一份，
// 避免同一个概念在四处各写一遍三元表达式——加第三个目标时就不会漏改。
export function targetLabel(kind?: string): string {
  if (kind === 'dsh') return 'DSH'
  if (kind === 'mofang') return '墨坊'
  return 'WorkBuddy'
}

/** 目标文件位置的人类可读描述；没定位到时说明原因，而不是留空。 */
export function targetPathOf(state: ServiceState): string {
  if (state.target === 'dsh') {
    const dsh = (state.dsh || {}) as { home?: string; profiles?: string[] }
    const profiles = dsh.profiles || []
    if (!profiles.length) return '未检测到 DSH profile；请先启动一次 DSH'
    return (dsh.home || '~') + '/profiles/{' + profiles.join(', ') + '}/cordis.patch.yml'
  }
  if (state.target === 'mofang') {
    const mofang = (state.mofang || {}) as { home?: string; file?: string | null; exists?: boolean }
    if (!mofang.exists) return '未找到墨坊配置；请先启动一次墨坊（预期 ' + (mofang.home || '~/.mofang') + '/config.json）'
    return mofang.file || (mofang.home || '~') + '/config.json'
  }
  return state.modelsFile || '尚未定位配置文件，导入时查找或选择'
}

/** 「写入」按钮的措辞：各目标的动作名不同，别让用户在三个目标下看到同一句话。 */
export function writeLabelOf(state: ServiceState): string {
  if (state.target === 'dsh') return '写入 DSH'
  if (state.target === 'mofang') return '写入墨坊'
  return '写入 WorkBuddy'
}

/**
 * 当前写入目标的体检结论（服务层现读配置得出）。
 * 页面所有「能不能移除 / 能不能写」的判断都读这一份，避免各页各算一套。
 */
export function inspectionOf(state: ServiceState): TargetInspection | undefined {
  const kind = state.target === 'dsh' ? 'dsh' : state.target === 'mofang' ? 'mofang' : 'workbuddy'
  return state.targets?.[kind]
}

/**
 * 上一次同步到底发生了什么。
 * count=0 有两种：真把条目摘掉了（changed），和本来就没有可摘的（启动时的空同步）——
 * 一律写成「0 个」会让人以为配置被清了，所以三处显示（状态面板 / 环境弹窗 / 配置卡）共用这一份。
 */
export function syncCountText(sync?: SyncState | null): string {
  const count = sync?.count
  if (count == null) return ''
  if (count > 0) return count + ' 个'
  return sync?.changed === false ? '无改动' : '已清空'
}

/**
 * 一个目标里**本接入线**的条目数和清单。
 * WorkBuddy 那份 models.json 是三路共写的，配置体检给出的 owned 是合计值：
 * 拿合计值当自己的账，会在 OpenCode 页把日日新写进去的条目算成"已写入"，
 * 进而让「移除配置」看起来可点、点下去却什么也没摘掉。
 */
export function sourceSliceOf(inspection: TargetInspection | undefined, route: string): { count: number, ids: string[] } {
  const slice = inspection?.sources?.[route]
  return {
    count: slice?.count ?? inspection?.owned ?? 0,
    ids: (slice?.ids ?? inspection?.ids ?? []).filter(Boolean),
  }
}
