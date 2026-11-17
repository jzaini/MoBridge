import { Menu, Tray, nativeImage, nativeTheme, app } from 'electron'
import { join } from 'node:path'
import { APP_NAME } from '../shared/constants'
import { activityText } from './activity'

// 托盘图标：开发态取项目根 resources/，打包后取安装目录 resources/（extraResources）。
// Windows/Linux 按系统主题选日间（浓墨，浅色任务栏）/夜间（霓青，深色任务栏）两版；
// macOS 用纯黑模板图标，系统自动适配菜单栏明暗。
function trayIconPath(): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  if (process.platform === 'darwin') return join(base, 'trayTemplate.png')
  return join(base, nativeTheme.shouldUseDarkColors ? 'tray-night.png' : 'tray-day.png')
}

export interface TrayState {
  phase: string
  message?: string
  target?: string
  models?: Array<{ id: string, name: string }>
  availableModels?: string[]
  modelResults?: Record<string, { chatOnly?: boolean }>
  activity?: Array<Parameters<typeof activityText>[0]>
  probe?: { running?: boolean }
  configSearch?: { running?: boolean }
  modelsFile?: string
}

export function createTray(onShow: () => void, onAction: (name: string, value?: unknown) => void) {
  const loadIcon = () => {
    const image = nativeImage.createFromPath(trayIconPath())
    if (process.platform === 'darwin') image.setTemplateImage(true)
    return image
  }
  const tray = new Tray(loadIcon())
  tray.on('click', onShow)
  // 系统明暗切换时换托盘图：day/night 两版线条色不同，静态一张总有半边看不清。
  nativeTheme.on('updated', () => {
    if (!tray.isDestroyed()) tray.setImage(loadIcon())
  })
  return tray
}

let lastMenu = ''
export function updateTrayMenu(
  tray: Tray | undefined,
  state: TrayState,
  actionBusy: string | false,
  labels: { show: string, quit: string, activity: (s: TrayState) => string },
  handlers: { show: () => void, quit: () => void, action: (name: string, value?: unknown) => void, settings?: () => void },
) {
  if (!tray) return
  tray.setToolTip(APP_NAME)
  const signature = JSON.stringify([state, actionBusy])
  if (signature === lastMenu) return
  lastMenu = signature
  const available = new Set(state.availableModels || [])
  const busy = !!actionBusy || !!state.configSearch?.running || !!state.probe?.running || state.phase !== 'ready'
  // 三个目标都要能从这里切：托盘是最短路径，缺一个就等于墨坊只能进面板才能用。
  const targetLabel = state.target === 'dsh' ? 'DSH' : state.target === 'mofang' ? '墨坊' : 'WorkBuddy'
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.activity(state), enabled: false },
    { label: labels.show, click: handlers.show },
    { type: 'separator' },
    { label: '重新扫描免费模型', enabled: !busy, click: () => handlers.action('refresh') },
    { label: '检测全部模型', enabled: !busy, click: () => handlers.action('probe') },
    { label: `写入 ${targetLabel}`, enabled: !busy, click: () => handlers.action('import') },
    { label: '写入目标', submenu: [
      { label: 'WorkBuddy', type: 'radio' as const, checked: state.target !== 'dsh' && state.target !== 'mofang', enabled: !busy, click: () => handlers.action('target', 'workbuddy') },
      { label: 'DSH', type: 'radio' as const, checked: state.target === 'dsh', enabled: !busy, click: () => handlers.action('target', 'dsh') },
      { label: '墨坊', type: 'radio' as const, checked: state.target === 'mofang', enabled: !busy, click: () => handlers.action('target', 'mofang') },
    ] },
    ...(process.platform === 'win32' && targetLabel === 'WorkBuddy'
      ? [
          { label: '自动查找 WorkBuddy 配置…', enabled: !busy, click: () => handlers.action('find-config') },
          { label: '选择 WorkBuddy 配置…', enabled: !busy, click: () => handlers.action('choose-config') },
        ]
      : []),
    { label: '模型状态', submenu: (state.models || []).map(m => ({
      label: `${m.name} · ${available.has(m.id) ? (state.modelResults?.[m.id]?.chatOnly ? '可用 · 仅对话' : '可用') : '不可用'}`,
      enabled: false,
    })) },
    { type: 'separator' },
    // 设置不受 busy 影响：检测正在跑的时候，用户照样可能想把超时调长或关掉开机自启。
    ...(handlers.settings ? [{ label: '设置…', click: handlers.settings }] : []),
    { label: `退出 ${APP_NAME}`, click: handlers.quit },
  ]))
}
