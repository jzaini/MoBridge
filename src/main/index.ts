import { app, BrowserWindow, Menu, ipcMain, dialog, screen, shell, nativeTheme } from 'electron'
import { fork, execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { APP_NAME, DEFAULT_SERVICE_PORT, DEFAULT_ATOMCODE_PORT, isAllowedExternal } from '../shared/constants'
import type { AppSettings, AppSettingsInfo, ServiceState } from '../shared/types'
import { activityText } from './activity'
import { createTray, updateTrayMenu, type TrayState } from './tray'

// Electron 只管窗口、托盘和后台服务的生命周期；真正的逻辑全在 fork 出来的
// 服务进程（src/service，esbuild 打包为 out/service/main.mjs）里——同一个核心
// 既能被桌面端驱动，也能 `npm start` 单跑。
app.setName(APP_NAME)
app.setAppUserModelId('com.mofang.mobridge')

let window: BrowserWindow | undefined
let tray: ReturnType<typeof createTray>
let service: ReturnType<typeof fork> | undefined
let timer: NodeJS.Timeout | undefined
let log: WriteStream | undefined
let quitting = false
let mayQuit = false
let actionBusy: string | false = false
let state: ServiceState = { phase: 'starting', message: '正在启动隔离模型服务', models: [], modelResults: {} }
let dataDir = ''

// ── 本地端口 ────────────────────────────────────────────────────────────
// 端口是设置项（settings.json 的 port / atomcodePort），但执行者是主进程：
// fork 服务时把端口算好当环境变量传下去，之后所有 admin 调用也走同一个值。
// 两边读同一份文件，所以不会出现"面板写了 31290、实际还在监听 31280"的分裂。
function validPort(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null
}
let servicePort = validPort(process.env.MOBRIDGE_PORT) ?? DEFAULT_SERVICE_PORT
let atomcodePort = validPort(process.env.MOBRIDGE_ATOMCODE_PORT) ?? DEFAULT_ATOMCODE_PORT

/** 环境变量优先（排障时用一次性值覆盖），其次 settings.json，最后是默认值。 */
async function loadServicePorts(): Promise<{ port: number, atomcodePort: number }> {
  let main = validPort(process.env.MOBRIDGE_PORT)
  let sub = validPort(process.env.MOBRIDGE_ATOMCODE_PORT)
  if (main === null || sub === null) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')) as Record<string, unknown>
      main = main ?? validPort(saved.port)
      sub = sub ?? validPort(saved.atomcodePort)
    } catch { /* 首次运行还没有 settings.json */ }
  }
  servicePort = main ?? DEFAULT_SERVICE_PORT
  // AtomCode 口留空就跟着主端口走（+2），用户不必改两处。
  atomcodePort = sub ?? Math.min(65535, servicePort + 2)
  return { port: servicePort, atomcodePort }
}

// ── 应用行为设置 ─────────────────────────────────────────────────────────
// 这几项不属于"检测"而是"这台机器上怎么跑"：开机自启、启动时是否露面。
// 它们写在 app-settings.json，与服务层的 settings.json 分开：
// 服务进程完全不需要知道窗口怎么显示，主进程也不需要知道检测超时。
//
// 这里刻意没有"关窗收到托盘"这一项：关窗口就是关软件。
// 一个看不见的常驻进程占着内存、还攥着打包产物的文件句柄，用户既不该被迫接受，
// 也不该靠"记得去托盘里退一次"才能真的关掉它。
const APP_SETTINGS_DEFAULTS: AppSettings = {
  autoLaunch: false,
  // 开机拉起的默认不抢屏幕：它只是个后台通路，用户真要用会从托盘点开。
  startHidden: true,
}
let appSettings: AppSettings = { ...APP_SETTINGS_DEFAULTS }

const appSettingsFile = () => path.join(dataDir, 'app-settings.json')

// 开机自启只能由装好的应用注册：开发态注册的是 electron.exe，
// 指向一个随时会被清理的路径，宁可不写（面板上会说明为什么点了没生效）。
function loginItemSupported(): boolean {
  return app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin')
}

function applyAutoLaunch(enabled: boolean) {
  if (!loginItemSupported()) return
  try {
    // --hidden 交给启动分支判断：跟着开机一起起来的只留托盘。
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
  } catch { /* 系统拒绝（策略/权限）时不阻断启动，面板会显示真实状态 */ }
}

function autoLaunchActive(): boolean {
  if (!loginItemSupported()) return false
  try { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin === true } catch { return false }
}

function appSettingsInfo(): AppSettingsInfo {
  return {
    ...appSettings,
    // 系统里此刻的真实状态：用户可能在任务管理器里关掉过，不能只回显自己的文件。
    autoLaunchActive: autoLaunchActive(),
    supported: loginItemSupported(),
    dataDir,
    logFile: path.join(dataDir, 'app.log'),
    appVersion: app.getVersion(),
  }
}

async function loadAppSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(appSettingsFile(), 'utf8')) as Partial<AppSettings>
    appSettings = {
      autoLaunch: saved.autoLaunch === true,
      startHidden: saved.startHidden !== false,
    }
  } catch { /* 首次运行没有这个文件，用默认值 */ }
}

async function applyAppSettings(patch: unknown): Promise<AppSettingsInfo> {
  const source = (patch && typeof patch === 'object' && !Array.isArray(patch)) ? patch as Record<string, unknown> : {}
  appSettings = {
    autoLaunch: typeof source.autoLaunch === 'boolean' ? source.autoLaunch : appSettings.autoLaunch,
    startHidden: typeof source.startHidden === 'boolean' ? source.startHidden : appSettings.startHidden,
  }
  await fs.writeFile(appSettingsFile(), JSON.stringify(appSettings, null, 2)).catch(() => {})
  applyAutoLaunch(appSettings.autoLaunch)
  return appSettingsInfo()
}

// WCO 原生区域（右上角最小化/最大化/关闭那一块）由 Electron 画，底色必须和
// 渲染层 .app-header 的 --surface **完全同色**（浅 #ffffff / 深 #242426）。
// 之前这里用的是 --background（#f5f5f7 / #1c1c1e），比白色顶栏灰一档，
// 于是顶栏右侧出现一条肉眼可见的色带。两处使用点（初始 + 主题切换）共用这一个函数。
const TITLE_BAR_SURFACE = { light: '#ffffff', dark: '#242426' } as const
const TITLE_BAR_SYMBOL = { light: '#7a7a80', dark: '#cfcfd4' } as const
const titleBarColors = (dark: boolean) => ({
  color: dark ? TITLE_BAR_SURFACE.dark : TITLE_BAR_SURFACE.light,
  symbolColor: dark ? TITLE_BAR_SYMBOL.dark : TITLE_BAR_SYMBOL.light,
})

const ACTIONS = ['refresh', 'probe', 'import', 'remove', 'system-proxy', 'restart', 'choose-config', 'find-config', 'selection', 'target',
  // 本地服务的启停：主进程管子进程，动作名以 service- 开头与服务层动作区分。
  'service-stop', 'service-start',
  // 日日新：与上面同一套动作语义，只是作用于直连上游的那条链路。
  'sn-save-key', 'sn-clear-key', 'sn-save-base', 'sn-reset-base', 'sn-validate', 'sn-probe', 'sn-selection', 'sn-import', 'sn-remove',
  // AtomCode：多出「安装 / 登录 / 刷新目录 / 网关」四个本机动作。
  'ac-detect', 'ac-install', 'ac-login', 'ac-refresh', 'ac-save-gateway', 'ac-reset-gateway', 'ac-selection', 'ac-import', 'ac-remove',
  // 只读体检：页面切页签时重新确认「当前目标里到底有没有我们的条目」。
  'inspect-targets',
  // 写入位置：选文件/目录（主进程弹系统对话框）与只读自动定位（服务层找路径、不写入）。
  'pick-target-path', 'auto-locate-path',
  // 设置（服务侧的检测/缓存旋钮）与判定缓存清理。
  'settings', 'clear-cache'] as const
type ActionName = (typeof ACTIONS)[number]

function targetName(result?: { target?: string }): string {
  if (result?.target === 'dsh') return 'DSH'
  if (result?.target === 'mofang') return '墨坊'
  return 'WorkBuddy'
}

// 与服务层 platform.ts 同一套数据目录规则；默认目录名为 MoBridge。
function dataDirectory(platform = process.platform, env = process.env, home = app.getPath('home')): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'MoBridge')
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'MoBridge')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'MoBridge')
}
function importMessage(result: { changed?: boolean, count?: number, target?: string }): string {
  return result.changed === false
    ? `${targetName(result)} 配置已是最新，共 ${result.count} 个模型，无需重复写入。`
    : `已将 ${result.count} 个可用模型写入 ${targetName(result)}。`
}
// 托盘只要"现在在观察哪件事"这一句文案：入参就用托盘的轻量状态，
// 不必要求完整的 ServiceState（否则 tray.ts 的 labels 类型就配不上）。
function activityLabel(s: TrayState): string {
  const a = (s.activity || [])[0]
  if (!a) return s.probe?.running ? '正在检测模型…' : s.message || '正在启动…'
  return activityText(a as never) || s.message || '…'
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('state', { ...state, actionBusy })
  updateTrayMenu(tray, state as TrayState, actionBusy,
    { show: '打开控制面板', quit: `退出 ${APP_NAME}`, activity: activityLabel },
    { show: showWindow, quit: () => app.quit(), action: (name, value) => trayAction(name, value), settings: openSettings })
}

async function readState() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8')) as ServiceState
    // pid 对不上说明这份状态是别的实例（或上一次运行）留下的，不认。
    if (value.pid === service?.pid && !quitting) { state = value; publish() }
  } catch { /* status.json 尚未生成，属正常 */ }
}

async function callService(name: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim()
  const response = await fetch(`http://127.0.0.1:${servicePort}/admin/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(150000),
  })
  const result = await response.json() as Record<string, unknown> & { error?: { message?: string } }
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`)
  await readState()
  return result
}

async function action(name: ActionName, value: unknown): Promise<Record<string, unknown>> {
  if (state.configSearch?.running) throw new Error('请等待配置查找完成')
  if (actionBusy) throw new Error('请等待当前操作完成')
  // 服务启停归主进程管（子进程在这儿），不受「服务是否 ready」的门禁约束：
  // 停止恰恰要在运行时可用；启动恰恰要在停止时才允许。
  if (name === 'service-stop') {
    actionBusy = name; publish()
    try {
      await stopService()
      state = { ...state, phase: 'stopped', message: '本地服务已停止', endpoint: undefined, pid: undefined, probe: { running: false }, actionBusy: undefined }
      return {}
    } finally { actionBusy = false; publish() }
  }
  if (name === 'service-start') {
    if (state.phase !== 'stopped') throw new Error('本地服务已在运行，无需重复启动')
    actionBusy = name; publish()
    try {
      state = { ...state, phase: 'starting', message: '正在启动隔离模型服务', endpoint: undefined }
      publish()
      await startService()
      return {}
    } finally { actionBusy = false; publish() }
  }
  if (name === 'restart') {
    actionBusy = name; publish()
    try {
      await restartService()
      return {}
    } finally { actionBusy = false; publish() }
  }
  // 选路径只是唤起系统对话框，不碰服务、也不写盘；返回路径交给渲染层统一提交 settings。
  // 放在 ready 门禁之前：服务没起来时也应该能先把位置改好。
  if (name === 'pick-target-path') {
    const spec = (value && typeof value === 'object' ? value : {}) as { target?: string }
    const target = spec.target || ''
    const labels: Record<string, string> = {
      workbuddy: 'WorkBuddy 的 models.json',
      dsh: 'DSH 数据目录（内含 profiles/）',
      mofang: '墨坊的 config.json',
    }
    if (!labels[target]) throw new Error('无效的写入目标')
    const isDir = target === 'dsh'
    const selection = await dialog.showOpenDialog({
      title: '选择' + labels[target],
      message: isDir ? '请选择 DSH 实际使用的数据目录（下面应有 profiles 子目录）。' : '请选择该客户端实际使用的配置文件。',
      properties: isDir ? ['openDirectory'] : ['openFile'],
      ...(isDir ? {} : { filters: [{ name: 'JSON 配置', extensions: ['json'] }] }),
    })
    if (selection.canceled || !selection.filePaths.length) return { canceled: true }
    return { target, path: selection.filePaths[0] }
  }
  if ((state.phase !== 'ready' && !(name === 'system-proxy' && state.phase === 'error')) || state.probe?.running)
    throw new Error('请等待服务启动和检测完成')
  if (name === 'system-proxy' && typeof value !== 'boolean') throw new Error('代理开关必须为布尔值')
  // 日日新的动作不需要 WorkBuddy 的 models.json，也不受「服务是否 ready」影响：
  // 它只跟用户填的 Key 和上游通不通有关。所以单独放行，不进下面那段导入流程。
  if (name.startsWith('sn-')) return await actionSensenova(name, value)
  if (name.startsWith('ac-')) return await actionAtomcode(name, value)
  if (name === 'inspect-targets') return await callService('inspect-targets')
  if (name === 'settings') {
    const patch = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
    const result = await callService('settings', patch)
    // 端口不是热参数：监听套接字定了就改不了。写完设置发现端口变了，就重启一次服务，
    // 而不是留一句"请自行重启"让用户去猜。
    const before = { port: servicePort, atomcodePort }
    const after = await loadServicePorts()
    if (after.port === before.port && after.atomcodePort === before.atomcodePort) return result
    await restartService()
    return { ...result, restarted: true, port: after.port, atomcodePort: after.atomcodePort }
  }
  if (name === 'clear-cache') return await callService('clear-cache')
  actionBusy = name; publish()
  try {
    let modelsFile: string | undefined
    // Windows 上先尝试自动查找配置：找到就转成 import，没找到再让用户手动选。
    // 这段只针对 WorkBuddy 的 models.json；DSH 与墨坊各有自己的配置文件，不走查找。
    if (process.platform === 'win32' && state.target !== 'dsh' && state.target !== 'mofang' && (name === 'find-config' || (name === 'import' && (!state.modelsFile || !(await fs.stat(state.modelsFile).catch(() => null))?.isFile())))) {
      let found = state.configSearch
      if (name === 'find-config' || !found?.candidates?.length) {
        found = await callService('find-config') as never as ServiceState['configSearch']
      }
      const candidates = found?.candidates || []
      if (candidates.length) {
        // 多个候选里取"校验前最后访问时间"最新的那份：不再弹窗让用户挑。
        modelsFile = candidates[0]
      } else {
        await dialog.showMessageBox({ type: 'info', message: found?.errors?.length ? '自动查找未完成，请手动选择' : '自动查找未找到配置，请手动选择',
          detail: found?.errors?.join('\n') || '请先在 WorkBuddy 保存一个自定义模型，再重试。' })
      }
      name = modelsFile ? 'import' : 'choose-config'
    }
    if (process.platform === 'win32' && name === 'choose-config') {
      const selection = await dialog.showOpenDialog({ title: '选择 WorkBuddy 的 models.json', message: '请选择 WorkBuddy 实际使用的配置文件。首次使用请先在 WorkBuddy 保存一个自定义模型。', properties: ['openFile'], filters: [{ name: 'JSON 配置', extensions: ['json'] }] })
      if (selection.canceled || !selection.filePaths.length) return { canceled: true }
      modelsFile = selection.filePaths[0]
      name = 'import'
    }
    const body = name === 'system-proxy' ? { enabled: value }
      : name === 'selection' ? value as Record<string, unknown>
      : name === 'target' ? { target: value }
      : name === 'auto-locate-path' ? { target: value }
      : name === 'probe' && typeof value === 'string' ? { model: value }
      : modelsFile ? { modelsFile }
      : {}
    return await callService(name, body)
  } finally { actionBusy = false; publish() }
}

// 日日新动作：统一转发到服务层的 /admin/sensenova/*，主进程只管白名单与超时。
async function actionSensenova(name: string, value: unknown): Promise<Record<string, unknown>> {
  const route = name.slice(3);
  const body = route === 'save-key' ? { key: value }
    : route === 'save-base' ? { apiBase: value }
    : route === 'selection' ? { ids: value }
    : {};
  const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${servicePort}/admin/sensenova/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 鉴权会把每个模型都真跑一遍，给足时间；其余是本地快操作。
    signal: AbortSignal.timeout(route === 'validate' || route === 'probe' ? 180000 : 20000),
  });
  const result = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  await readState();
  return result;
}

// AtomCode 动作：安装与登录可能跑几分钟，超时按动作区分，别用同一个数把安装误判成失败。
async function actionAtomcode(name: string, value: unknown): Promise<Record<string, unknown>> {
  const route = name.slice(3);
  const body = route === 'save-gateway' ? { gateway: value }
    : route === 'selection' ? { ids: value }
    : {};
  const limit = route === 'install' ? 320000 : route === 'login' ? 200000 : 60000;
  const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${servicePort}/admin/atomcode/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(limit),
  });
  const result = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
  await readState();
  return result;
}

async function trayAction(name: string, value?: unknown) {
  try {
    const result = await action(name as ActionName, value)
    // 写入/切换的结果由页面用浮层通知呈现：模态框每次都要用户点一下，属于纯打断。
    // 只有「选文件」这类需要用户当场知道结果的动作还留对话框。
    if (['choose-config', 'find-config'].includes(name) && !(result as { canceled?: boolean }).canceled) {
      await dialog.showMessageBox({
        type: 'info', title: APP_NAME,
        message: (result as { changed?: boolean }).changed === false ? '配置已是最新' : '写入完成',
        detail: importMessage(result as { changed?: boolean, count?: number, target?: string }),
      })
    }
  } catch (e) {
    await dialog.showMessageBox({ type: 'error', title: APP_NAME, message: '操作失败', detail: (e as Error).message })
  }
}

function ensureWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window
  // 按屏幕工作区自适应，让模型清单尽量铺满内容。
  const workArea = screen.getPrimaryDisplay().workArea
  const width = Math.min(1360, Math.max(1100, workArea.width - 120))
  const height = Math.min(900, Math.max(760, workArea.height - 100))
  window = new BrowserWindow({
    width, height, minWidth: 1000, minHeight: 680, title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    // 标题栏并入应用第一行（接入行）：原生最小化/最大化/关闭画在右上角，
    // 省掉一整条只放三个按钮的系统标题栏。高度与渲染层 .app-header 对齐。
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...titleBarColors(nativeTheme.shouldUseDarkColors), height: 52 },
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.setMenu(null)
  // 不承载远端内容：不在 Electron 里开新窗口；但官网链接（管理页/文档）
  // 需要能唤起系统浏览器，白名单内的 https 交给 shell.openExternal，其余一律拒绝。
  window.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = isAllowedExternal(url)
    if (allowed) shell.openExternal(allowed)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (mayQuit) return
    // 关窗口 = 退出软件。先 preventDefault 再走正常退出流程：
    // 让服务有时间收摊（停本地端口、结束运行时），而不是留下一个占内存的孤儿进程。
    event.preventDefault()
    app.quit()
  })
  window.on('blur', () => window?.webContents.send('dismiss-details'))
  if (process.env['ELECTRON_RENDERER_URL']) window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else window.loadFile(path.join(__dirname, '../renderer/index.html'))
  return window
}

function showWindow() {
  const current = ensureWindow()
  current.show(); current.focus()
}

// 托盘 / 快捷键要求打开设置：窗口可能是刚建出来的，等它加载完再发，
// 否则消息会早于渲染层的监听注册，点一下等于没点。
function openSettings() {
  const fresh = !window || window.isDestroyed()
  showWindow()
  const send = () => window?.webContents.send('open-settings')
  if (fresh) window?.webContents.once('did-finish-load', send)
  else send()
}

async function startService() {
  await fs.mkdir(dataDir, { recursive: true })
  log = createWriteStream(path.join(dataDir, 'app.log'), { flags: 'a' })
  // 用 Electron 自带的 Node 跑后台服务：最终用户不需要另装 Node。
  service = fork(path.join(__dirname, '../service/main.mjs'), [], {
    execPath: process.execPath, execArgv: [],
    // 端口按设置算好后传下去：服务只认环境变量，不必自己再解析一遍设置。
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', MOBRIDGE_DATA_DIR: dataDir,
      MOBRIDGE_PORT: String(servicePort), MOBRIDGE_ATOMCODE_PORT: String(atomcodePort),
    },
    cwd: dataDir, windowsHide: true, silent: true,
  })
  service.stdout?.pipe(log, { end: false })
  service.stderr?.pipe(log, { end: false })
  service.on('error', error => { state = { ...state, phase: 'error', message: error.message }; publish() })
  service.on('exit', code => {
    if (!quitting) { state = { ...state, phase: 'error', message: `服务已退出（${code}），请退出后重新启动应用` }; publish() }
  })
  timer = setInterval(readState, 500)
}

async function restartService() {
  await stopService()
  state = { phase: 'starting', message: '正在启动隔离模型服务', models: [], modelResults: {} }
  publish()
  await startService()
}

async function stopService() {
  clearInterval(timer)
  if (service && service.exitCode === null && service.signalCode === null) {
    const child = service
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    // 走 IPC 让服务自己收摊：停本地端口、结束运行时、把状态与缓存落盘。
    if (child.connected) child.send('shutdown')
    // 8 秒足够它把该写的写完。关窗口的人不该为一次退出干等——等不到就直接收掉，
    // 反正客户端配置在退出时已经不再被改动（见服务层 shutdown 的说明）。
    const finished = await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 8000))])
    if (!finished) {
      if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
      else child.kill('SIGKILL')
    }
  }
  log?.end()
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  // 关窗即退出：真正推下去的是 before-quit 里的收摊流程，
  // 这里留空是为了不让 Electron 的默认行为抢先退一半。
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (mayQuit) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    // 兜底闸：不管服务卡在检测还是运行时收尾，20 秒后一律退出。
    // 用户点的是「关闭」，不是一个可以无限期等待的请求。
    const watchdog = setTimeout(() => { mayQuit = true; app.exit(0) }, 20000)
    stopService().catch(() => {}).finally(() => { clearTimeout(watchdog); mayQuit = true; app.quit() })
  })
  app.whenReady().then(async () => {
    // 数据目录默认 MoBridge：无缝继承已保存的 API Key、
    // 勾选记录与写入状态；如需隔离可用 MOBRIDGE_DATA_DIR 覆盖。
    dataDir = process.env.MOBRIDGE_DATA_DIR || dataDirectory()
    await loadAppSettings()
    // 端口要在 fork 之前算好：服务只认环境变量，不会自己去读设置。
    await loadServicePorts()
    // 只在用户选过"开机自启"时回写注册表：关着的时候回写等于替用户重新注册，
    // 用户若在任务管理器里手工关过，这里不该把它偷偷打开。
    if (appSettings.autoLaunch) applyAutoLaunch(true)
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ label: `退出 ${APP_NAME}`, role: 'quit' }] },
      { label: '编辑', submenu: [{ label: '复制', role: 'copy' }, { label: '全选', role: 'selectAll' }] },
    ]))
    app.setPath('userData', dataDir)

    ipcMain.handle('action', async (event, name: string, value: unknown) => {
      // 只接受控制面板主框架发来的请求：iframe 或别处的脚本一律拒绝。
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('拒绝未知来源')
      if (!ACTIONS.includes(name as ActionName)) return { ok: false, error: '未知操作' }
      try {
        const result = await action(name as ActionName, value)
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    })
    // 应用行为设置：读一次拿全量（含系统真实状态），写只发改动项。
    ipcMain.handle('app-settings', (event) => {
      if (event.sender !== window?.webContents) throw new Error('拒绝未知来源')
      return appSettingsInfo()
    })
    ipcMain.handle('set-app-settings', async (event, patch: unknown) => {
      if (event.sender !== window?.webContents) throw new Error('拒绝未知来源')
      const info = await applyAppSettings(patch)
      publish()
      return info
    })
    // 官网链接：页面按钮显式走这个通道（window.open 已被 deny，双保险）。
    ipcMain.handle('open-external', (_event, url: string) => {
      const allowed = isAllowedExternal(url)
      if (allowed) shell.openExternal(allowed)
      return { ok: !!allowed }
    })
    // 主题三态：渲染层主导 UI 主题，主进程同步 nativeTheme 让窗口标题栏跟随。
    ipcMain.handle('set-theme-source', (_event, choice: string) => {
      if (['system', 'dark', 'light'].includes(choice)) nativeTheme.themeSource = choice as 'system' | 'dark' | 'light'
      return { ok: true, dark: nativeTheme.shouldUseDarkColors }
    })
    nativeTheme.on('updated', () => {
      if (window && !window.isDestroyed()) window.webContents.send('native-theme-changed', nativeTheme.shouldUseDarkColors)
      // 标题栏按钮随主题换色：窗口底色变化时 overlay 若还停在旧色，会留一圈突兀的色块。
      try {
        if (process.platform === 'win32' && window && !window.isDestroyed()) {
          window.setTitleBarOverlay(titleBarColors(nativeTheme.shouldUseDarkColors))
        }
      } catch { /* 旧版系统不支持动态改色，保持初始色即可 */ }
    })

    tray = createTray(showWindow, (name, value) => trayAction(name, value))
    ensureWindow()
    publish()
    // 跟着开机一起起来的（或带 --hidden 的）不抢屏幕：窗口照建，但先不显示，
    // 渲染层照样收状态，用户从托盘点开就是实时画面。
    const openedAtLogin = (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin === true } catch { return false } })()
    const quiet = (process.argv.includes('--hidden') || openedAtLogin) && appSettings.startHidden
    if (!quiet) showWindow()
    await startService()
  }).catch(error => { dialog.showErrorBox('启动失败', error.message); app.quit() })
}
