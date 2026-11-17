# 墨桥 MoBridge

> **墨坊造器，墨桥通路。**
> 把第三方免费模型接进你的客户端软件 —— 检测真实可用性，勾选要用的模型，一键写入配置。

墨桥（MoBridge）是「墨坊」家族的通路产品：墨坊负责造器（Agent 编程体），墨桥负责搭桥（模型接入）。
它在本机后台跑一个隔离的模型服务，向各路免费模型发极小请求测出真实可用性与耗时，
再把可用的模型写入墨坊 / WorkBuddy / DSH 的配置——只动自己写入的条目，不碰其它工具的配置。

## 功能

| 接入页 | 状态 | 说明 |
| --- | --- | --- |
| OpenCode 接入 | ✅ 可用 | 免费模型目录 / 真实检测（超时·额度·限流·受限分类）/ 勾选写入 / 系统代理 / 移除配置 |
| AtomCode 接入 | ✅ 可用 | 安装引导 / 登录 / CodingPlan 实时目录（离线回落 config.toml）/ 档位额度 / 可编辑网关 / 独立转发口（默认 31282，可改） |
| 日日新接入 | ✅ 可用 | 商汤日日新 API Key 管理（本机 0600 保存）/ 真实校验与逐模型探测 / 勾选直连写入（不经转发口） |

三路来源共用同一套写入目标与「只动自己条目」的规矩，靠 owner 标记区分，互不擦除：

| 写入目标 | 形态 | 标记 |
| --- | --- | --- |
| 墨坊 jzWorkBuddy | `~/.mofang/config.json` 的 `providers[]`（旧的 `~/.ai-coding-tool` 自动沿用） | `mobridgeOwner: mobridge-*-v1` |
| WorkBuddy | `models.json` 清单 | `mobridgeOwner: mobridge-v1`（兼容旧的 `buddyBridgeOwner`） |
| DSH | 各 profile 的 `cordis.patch.yml` 里的 provider | provider id（`mobridge` / `mobridge-atomcode` …） |

同一份配置里三路来源各占各的 owner（`mobridge-v1` / `mobridge-atomcode-v1` / `mobridge-sensenova-v1`），
任何一个来源的「写入」只覆盖自己的条目、「移除」只摘自己的条目；墨坊的 `activeProvider` 不会被改动。

各来源写入客户端时的模型名前缀：OpenCode `OC · `、AtomCode `AC · `、日日新 `SN · `；
两路转发口不同（主转发口默认 31280、AtomCode 默认 31282，都能在设置里改），日日新直连上游、不占端口。

OpenCode 接入页要点：

- **三步进度条**：连接服务 → 检测模型 → 写入配置，随状态自动推进；右侧为接入状态面板（8 项概览）。
- **状态口径诚实**：「—」表示 OpenCode 未公开上下文数值，页面不编造；耗时为完整请求用时；缓存判定会明确标注。
- **写入安全**：写入/移除均带 owner 标记的覆盖式同步 + 二次确认弹窗；移除只摘掉墨桥写入的条目。
- **失败可解释**：每条不可用模型都有失败原因（tooltip + 详情弹窗），支持单模型「重测」与「检测选中」省额度。
- **首次下载可见**：本机没有 OpenCode 运行时时会下载约 76 MB 平台包，页面按秒显示来源、百分比、已下载/总量与速度；
  25 秒收不到任何新数据就断开换源（镜像优先、官方兜底，校验值始终用官方元数据里的那一份）。

## 架构

```
src/
├─ main/        Electron 主进程：窗口/托盘/生命周期/IPC 白名单/动作互斥
├─ preload/     contextBridge：只暴露 state 订阅 + 固定动作集，本机口令不下发
├─ renderer/    Vue 3 + Naive UI 控制面板（三态主题，Naive darkTheme + 墨青主色）
├─ service/     纯 Node ESM 服务层（TypeScript，20 个模块，按领域分包）
│  ├─ core/       进程生命周期 + HTTP 管理面（main/server/service-instance/runtime/platform）
│  ├─ domain/     模型/API 领域逻辑（protocol/backend/probe/repair/handoff/model-status/reasoning/probe-cache/sensenova/atomcode）
│  ├─ config/     配置发现与写入（config-finder/workbuddy-config/dsh-config/mofang-config/sensenova/atomcode/system-proxy）
│  └─ sync/       文件同步 + 原子写入 + JSON 工具（sync/atomic/json）
│  （core 里另有 atomcode-bridge：AtomCode 专用转发口，与主转发口两套语义分开）
└─ shared/      常量、白名单，以及全项目接口契约单一真源 types.ts
test/           node:test 单测（15 个文件，覆盖服务层全量逻辑）
scripts/        图标栅格化管线（SVG → Chrome 512px → 盒式缩放 PNG）
```

- 服务层用 `esbuild` 打包为 `out/service/main.mjs`，由主进程以 `ELECTRON_RUN_AS_NODE` fork——
  **最终用户不需要安装 Node**；同一份服务层也能脱离 Electron 单独运行。
- 渲染层与主进程之间只有两条通道：`onState` 状态广播（约 500ms 一推）与白名单 `action` 动作。
- 外链一律经主进程域名白名单 + `shell.openExternal`，Electron 内不开远端窗口。

## 目录约定

根目录按「源码 / 资产源 / 生成物 / 工具」分开，生成物不混进源码树：

```
moBridge/
├─ src/                      源码
│  ├─ main/ preload/          Electron 主进程、预加载
│  ├─ renderer/index.html     渲染层入口（electron-vite 约定：入口在 renderer 根）
│  ├─ renderer/src/           Vue 应用源码（@ 指向这里，import 全部从这里出发）
│  ├─ service/                纯 Node 服务层（core / domain / config / sync）
│  └─ shared/                 主进程、预加载、渲染层共用的接口契约
├─ test/                     node:test 单测（只测服务层，不依赖 Electron）
├─ docs/                     项目文档（踩坑复盘与防再犯手册等）
├─ resources/                运行时资源：*.svg 为图标源，tray*.png 为生成的托盘图标（日/夜/模板三版）
├─ brand/                    「墨」家族品牌资产：墨桥三形态 SVG + 家族视觉规范（真源）
│                             （墨坊图标/规范副本/桌宠均已归位墨坊仓库：docs/brand/ 与 desktop-electron/design/pet/）
├─ build/                    安装包资源（electron-builder 的 buildResources 约定目录）
│                             icon*.png 为生成的应用图标，win.icon 指向 build/icon.png
├─ scripts/                  开发期工具（图标栅格化管线）
├─ out/                      构建输出（out/main、out/preload、out/renderer、out/service）
├─ release/                  打包输出（NSIS 安装包 / 便携版）
└─ tsconfig*.json            三份配置分别对应 web、node 与根引用
```

| 路径 | 类型 | 入库 | 说明 |
| --- | --- | --- | --- |
| `resources/*.svg` | 源 | 是 | 图标唯一真源，改图标只改这里 |
| `resources/tray*.png`、`build/icon*.png` | 生成物 | 是 | 由 `npm run icons` 产出并提交，打包时不再依赖 Chrome |
| `brand/` | 源 | 是 | 品牌视觉真源（墨桥三形态 SVG + 家族规范）；墨坊侧副本在墨坊仓库 docs/brand/ |
| `out/`、`release/`、`dist/`、`node_modules/` | 生成物 | 否 | 随时可重建，不要手工往里放文件 |
| `src/renderer/index.html` + `src/renderer/src/` | 源 | 是 | 两层职责不同，不是重复目录 |

**项目文档**：[`docs/踩坑复盘与防再犯手册.md`](docs/踩坑复盘与防再犯手册.md) —— 按「现象 → 根因 → 解决方案 → 防再犯」登记全项目 108 条踩坑记录（Electron 壳层 / WCO / 打包 / UI / 服务 / 配置写入 / 验证方法 / 协作红线），含**新 Electron 项目开工 Checklist** 与遗留风险表。开工前建议通读一遍。

**Windows 建目录约定**：不要用 bash 花括号展开批量建目录（如 `mkdir -p src/renderer/{a,b,c}`）。PowerShell / cmd 不展开花括号，会把它们当成字面字符，生成 `{a`、`b}` 之类的空目录；空目录不进版本库，容易长期残留而不被发现。目录请逐条写全路径，或用 `fs.mkdirSync(path, { recursive: true })` 这类显式调用。自查：

```powershell
Get-ChildItem -Path src -Recurse -Directory -Force | Where-Object Name -match '[\{\}]'
```

正常应无输出。

## 数据与隐私

- API Key、勾选记录、写入状态**全部只存本机**；管理 API 用本机 Bearer 令牌，不下发到页面。
- 数据目录默认 `MoBridge`（`%APPDATA%/MoBridge`），已保存的 API Key 与勾选记录直接复用；
  如需隔离可用环境变量 `MOBRIDGE_DATA_DIR` 覆盖。

## 开发

```bash
npm install        # 安装依赖（首次）
npm run dev        # 构建服务层 + electron-vite 开发模式
npm test           # node:test 单测（需先 npm install，依赖 Node 22+ 的 strip-types）
npm run typecheck  # vue-tsc + tsc 双工程检查
npm run icons      # 重新生成图标资产（需要本机 Chrome/Edge）
```

## 构建安装包

```bash
npm run build:win           # NSIS 安装包（x64）
npm run build:win:portable  # 便携版
```

## License

MIT
