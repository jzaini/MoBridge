import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings, AppSettingsInfo, ServiceState } from '../shared/types'

// 渲染进程只能看到状态和一组固定动作，本机口令不下发到页面里。
// ServiceState 的形状统一定义在 src/shared/types.ts（主进程/预加载/渲染层共用）。

const api = {
  action: (name: string, value?: unknown): Promise<{ ok: boolean, result?: unknown, error?: string }> =>
    ipcRenderer.invoke('action', name, value),
  onState: (callback: (state: ServiceState) => void): void => {
    ipcRenderer.on('state', (_event, state) => callback(state))
  },
  onDismiss: (callback: () => void): void => {
    ipcRenderer.on('dismiss-details', () => callback())
  },
  openExternal: (url: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('open-external', url),
  setThemeSource: (choice: 'system' | 'dark' | 'light'): Promise<{ ok: boolean, dark: boolean }> =>
    ipcRenderer.invoke('set-theme-source', choice),
  onNativeThemeChanged: (callback: (dark: boolean) => void): void => {
    ipcRenderer.on('native-theme-changed', (_event, dark: boolean) => callback(dark))
  },
  // 应用行为设置（开机自启 / 启动是否露面 / 关窗去向）在主进程里，不走服务层。
  getAppSettings: (): Promise<AppSettingsInfo> => ipcRenderer.invoke('app-settings'),
  setAppSettings: (patch: Partial<AppSettings>): Promise<AppSettingsInfo> => ipcRenderer.invoke('set-app-settings', patch),
  // 托盘"设置…"入口：主进程把窗口拉到前台后通知页面打开设置面板。
  onOpenSettings: (callback: () => void): void => {
    ipcRenderer.on('open-settings', () => callback())
  },
}

export type Bridge = typeof api
contextBridge.exposeInMainWorld('bridge', api)
