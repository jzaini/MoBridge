# 墨桥 MoBridge

> **墨坊造器，墨桥通路。**
> 把第三方免费模型接进你的客户端软件 —— 检测真实可用性，勾选要用的模型，一键写入配置。

墨桥（MoBridge）是「墨坊」家族的通路产品：墨坊负责造器（Agent 编程体），墨桥负责搭桥（模型接入）。
它在本机后台跑一个隔离的模型服务，向各路免费模型发极小请求测出真实可用性与耗时，
再把可用的模型写入你的客户端配置——只动自己写入的条目，不碰其它工具的配置。

---

## 为什么做墨桥

第三方免费模型的接入有三个反复出现的痛点：

1. **可用性是黑盒**：目录里挂着 11 个免费模型，实际能不能用、是不是限额、响应多慢——只有发真实请求才知道，用户没有工具逐个验证。
2. **配置手写易错**：每个客户端的模型配置格式都不一样（JSON 清单 / YAML provider / SQLite），手写容易漏字段、写错端点，出了问题很难定位。
3. **多工具配置互相踩**：几个 AI 客户端共用一份配置目录，工具 A 的写入把工具 B 的条目抹掉，是谁干的都查不出来。

墨桥的答案是一条完整链路：**检测 → 勾选 → 写入**。检测用极小请求逐个量出真实可用性；勾选决定"哪些要写入"；写入由墨桥按各客户端的格式落地，并只覆盖自己标记的条目——你的配置永远不会被墨桥之外的任何一方破坏。

## 设计理念

墨桥的每条设计都围绕四个词：**隔离、诚实、克制、可解释**。

### 隔离 —— 一个独立于 Electron 的服务层

- 服务层是纯 Node ESM（TypeScript，33 个模块按领域分包），由主进程以 `ELECTRON_RUN_AS_NODE` fork——**最终用户不需要安装 Node**，同一份服务层也能脱离 Electron 单独运行。
- 渲染层与主进程之间只有两条通道：`onState` 状态广播（约 500ms 一推）与白名单 `action` 动作集。页面拿不到本机口令，做不到白名单之外的事。
- 外链一律经主进程域名白名单 + `shell.openExternal`，Electron 内不开远端窗口。
- API Key、勾选记录、写入状态**全部只存本机**（`%APPDATA%/MoBridge`），管理 API 用本机 Bearer 令牌，不下发到页面。

### 诚实 —— 状态口径不编造

- 「可用」是向模型发真实请求量出来的，不是目录声明；失败原因逐条落库（额度 / 限流 / 超时 / 受限各归各类），tooltip 和详情弹窗都能看到"为什么不可用"。
- 官方未公开的数值标「—」，页面不编造；耗时是完整请求用时；缓存判定会明确标注来源。
- 上游的英文报错会被翻译成人话：`Free usage exceeded` → 「免费额度用完了，不是配置问题」；`rate limit` → 「额度或频率超限」。

### 克制 —— 只动自己的条目

- 三路来源（OpenCode / AtomCode / 日日新）共用同一套写入目标，靠 owner 标记区分，互不擦除：任何来源的「写入」只覆盖自己的条目、「移除」只摘自己的条目。
- 退出应用**不动**客户端配置——「退出」和「移除」是两件事，数据副作用永远由显式动作触发。
- 切换写入目标默认不迁移不清理（可在设置开启）：切方向，不删东西。

### 可验证 —— 150 条单测守服务层

- `test/` 下 22 个文件、150 条用例（node:test），覆盖转发口鉴权、探测缓存、配置写入、原子落盘、并发池、错误翻译等全量服务层逻辑，**不依赖 Electron**——CI 一条命令跑完。
- 类型检查双工程并行（渲染层 vue-tsc + 服务层 tsc），接口契约单一真源在 `src/shared/types.ts`。

## 个性特色

- **「墨」家族视觉**：墨桥三形态 SVG 图标（生成 PNG / ICO / 托盘日/夜/模板三版）、墨青主色、三态主题（跟随系统 / 浅色 / 深色）随切换同步窗口原生按钮颜色。
- **双向可读的模型名**：写入客户端的是带来源前缀的名字（`OC · ` / `AC · ` / `SN · `），转发口认得这些名字，发上游前换回真名——客户端好认，上游认对。
- **分级探测缓存**：成功判定缓存久（默认 6 小时）、超时只缓存很短时间、明确的下线判定缓存更久——既省额度又不撒谎。
- **能力三列**：识图（可发图）/ 生图（图像生成）/ 工具调用，写入客户端时按真实能力落盘（vision / multimodal / supportsToolCall），只对话模型自动降级而不是悄悄报错。
- **失败与修复分离**：格式装不下工具调用时会再用一次纯对话确认"它至少能聊天"，能就按仅对话发布；只有确认不能用的模型才撤下。
- **首次下载可见**：本机没有 OpenCode 运行时会自动下载约 76 MB 平台包，页面按秒显示来源、百分比、速度；25 秒无数据断开换源（国内镜像优先、官方兜底，校验值始终用官方元数据里的那一份）。
- **账本上报**：转发口的每次真实调用以单行 JSONL 落盘给墨镜（MoLens）采集，fire-and-forget，失败静默——记账绝不阻塞转发。
- **免特权打包**：exe 图标由 afterPack 钩子用内置 rcedit 直接嵌入，不需要开发者模式或管理员权限；安装器自定义 NSIS 脚本让安装落在用户所选的目录本身。

## 功能

| 接入页 | 状态 | 说明 |
| --- | --- | --- |
| OpenCode 接入 | ✅ 可用 | 免费模型目录 / 真实检测（超时·额度·限流·受限分类）/ 勾选写入 / 系统代理 / 移除配置 |
| AtomCode 接入 | ✅ 可用 | 安装引导 / 登录 / CodingPlan 实时目录（离线回落 config.toml）/ 档位额度 / 可编辑网关 / 独立转发口（默认 31282，可改） |
| 日日新接入 | ✅ 可用 | 商汤日日新 API Key 管理（本机保存）/ 真实校验与逐模型探测 / 勾选直连写入（不经转发口） |

三路来源共用同一套写入目标与「只动自己条目」的规矩，靠 owner 标记区分，互不擦除：

| 写入目标 | 形态 | 标记 |
| --- | --- | --- |
| 墨坊 jzWorkBuddy | `~/.mofang/config.json` 的 `providers[]`（旧的 `~/.ai-coding-tool` 自动沿用） | `mobridgeOwner: mobridge-*-v1` |
| WorkBuddy | `models.json` 清单 | `mobridgeOwner: mobridge-v1`（兼容旧的 `buddyBridgeOwner`） |
| DSH | 各 profile 的 `cordis.patch.yml` 里的 provider | provider id（`mobridge` / `mobridge-atomcode` …） |
| Qoder | `~/.qoder-cn/settings.json`（国际版 `~/.qoder/`）的 BYOK `providers` | `mobridgeOwner: mobridge-*-v1` + 键前缀 `qoder-custom-mobridge-` |
| Trae | `%APPDATA%/Trae CN/User/globalStorage/state.vscdb` 的模型清单键（SQLite，写入前需退出 Trae） | `mobridgeOwner: mobridge-*-v1`；已知限制：Trae 原生保存 Key 时加密，墨桥按用户拍板写明文（见手册 §14） |

同一份配置里三路来源各占各的 owner（`mobridge-v1` / `mobridge-atomcode-v1` / `mobridge-sensenova-v1`），
任何一个来源的「写入」只覆盖自己的条目、「移除」只摘自己的条目；墨坊的 `activeProvider` 不会被改动。

各来源写入客户端时的模型名前缀：OpenCode `OC · `、AtomCode `AC · `、日日新 `SN · `；
两路转发口不同（主转发口默认 31280、AtomCode 默认 31282，都能在设置里改），日日新直连上游、不占端口。

## 架构

```
src/
├─ main/        Electron 主进程：窗口/托盘/生命周期/IPC 白名单/动作互斥
├─ preload/     contextBridge：只暴露 state 订阅 + 固定动作集，本机口令不下发
├─ renderer/    Vue 3 + Naive UI 控制面板（三态主题，Naive darkTheme + 墨青主色）
├─ service/     纯 Node ESM 服务层（TypeScript，33 个模块，按领域分包）
│  ├─ core/       进程生命周期 + HTTP 管理面（main/server/service-instance/runtime/platform）
│  │               另有 atomcode-bridge：AtomCode 专用转发口；ledger-hook：墨镜账本上报
│  ├─ domain/     模型/API 领域逻辑（protocol/backend/probe/repair/handoff/model-status/reasoning/probe-cache/pool/sensenova/atomcode）
│  ├─ config/     配置发现与写入（config-finder/workbuddy-config/dsh-config/mofang-config/qoder-config/trae-config/atomcode/system-proxy/target-paths）
│  └─ sync/       文件同步 + 原子写入 + JSON 工具
└─ shared/      常量、白名单，以及全项目接口契约单一真源 types.ts
test/           node:test 单测（22 个文件 / 150 条用例，只测服务层，不依赖 Electron）
scripts/        打包辅助（图标栅格化管线 / NSIS 图标嵌入 / NSIS 自定义脚本）
build/          安装包资源（electron-builder buildResources）+ installer.nsh 自定义安装脚本
```

转发与检测的数据流：

```
客户端（WorkBuddy / DSH / Qoder / Trae …）
   │  OpenAI 兼容接口（127.0.0.1:31280，AtomCode 专用口 31282）
   ▼
墨桥服务层（鉴权 → 模型名还原 → 探测缓存 → OpenCode agent / AtomCode daemon / 日日新直连）
   │                                   │
   ▼                                   ▼
上游免费模型                       写入目标配置（owner 标记，只动自己的条目）
```

## 目录约定

根目录按「源码 / 资产源 / 生成物 / 工具」分开，生成物不混进源码树：

| 路径 | 类型 | 入库 | 说明 |
| --- | --- | --- | --- |
| `src/` | 源 | 是 | main / preload / renderer / service / shared 五层，见上节 |
| `resources/*.svg` | 源 | 是 | 图标唯一真源，改图标只改这里 |
| `resources/tray*.png`、`build/icon*` | 生成物 | 是 | 由 `npm run icons` 产出并提交，打包时不再依赖 Chrome |
| `brand/` | 源 | 是 | 「墨」家族品牌视觉真源（墨桥三形态 SVG + 家族规范） |
| `docs/` | 源 | 是 | 项目文档（踩坑手册等） |
| `out/`、`release/`、`dist/`、`node_modules/` | 生成物 | 否 | 随时可重建；release 按时间戳分目录，每次构建一个 |

**项目文档**：[`docs/踩坑复盘与防再犯手册.md`](docs/踩坑复盘与防再犯手册.md) —— 按「现象 → 根因 → 解决方案 → 防再犯」登记全项目踩坑记录（Electron 壳层 / WCO / 打包 / UI / 服务 / 配置写入 / 验证方法 / 协作红线），含**新 Electron 项目开工 Checklist** 与遗留风险表。开工前建议通读一遍。

## 下载

到仓库的 **Releases**（发行版）页面下载对应平台的 NSIS 安装包（`墨桥 Setup x.x.x.exe`），安装时可以自选目录。
每个版本对应一个 git tag（`v0.2.0` …），Release 说明里附当版要点。

## 开发

```bash
npm install        # 安装依赖（首次，需要 Node 22+）
npm run dev        # 构建服务层 + electron-vite 开发模式
npm test           # node:test 单测（150 条，只测服务层）
npm run typecheck  # vue-tsc + tsc 双工程检查
npm run icons      # 重新生成图标资产（需要本机 Chrome/Edge）
```

开发约定：`package.json` 的修改一律用 Node 脚本（PowerShell 的 Set-Content 会破坏中文编码）；
Windows 建目录不用 bash 花括号展开（cmd/PowerShell 不展开，会生成 `{a`、`b}` 字面目录）。

## 构建安装包

```bash
npm run build:win           # NSIS 安装包（x64），输出 release/<时间戳>/
npm run build:win:portable  # 便携版
```

- exe 图标由 `scripts/embed-icon.cjs`（afterPack 钩子）嵌入，**无需开发者模式或管理员权限**；
  安装目录行为由 `build/installer.nsh` 自定义（装到用户所选目录本身，不再多建一层包名目录）。
- 构建二进制走国内镜像（npmmirror），避免直连 GitHub 超时。
- 发版流程：改 `package.json` 的 `version` → `npm run build:pack` → 提交代码 → 打同名 tag（`v0.2.0`）→ 平台 Releases 页上传安装包。

## License

MIT
