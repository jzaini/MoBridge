// 服务层打包（esbuild JS API）。
//
// 为什么不用原来的 CLI 一行命令：bundle 里含有 undici 这类 CJS 依赖，
// 打成纯 ESM 后 esbuild 会生成 __require shim，纯 ESM 作用域没有 require，
// 运行时抛 `Error: Dynamic require of "node:assert" is not supported`，
// 后台服务一启动就崩（界面能开、服务 error）。
//
// 顶部注入 createRequire 后，shim 的 `typeof require !== "undefined"` 分支
// 会走真实的 Node require。用 JS API 而不是 CLI --banner 参数，是为了避开
// Windows cmd.exe / npm script 的引号解析差异。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/service/core/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'out/service/main.mjs',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
