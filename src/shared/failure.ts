// 把上游 / 本机 CLI 的报错翻成人话（纯函数，不碰 DOM、不弹浮层）。
//
// 起因：AtomCode 登录失败时，浮层里直接甩出一整段英文——
// 「Windows interactive mode requires console input and output; this terminal provides pipes.
//   In MobaXterm, launch with 'winpty atomcode.exe' …」。
// 用户在中文界面里看到一坨英文，既不知道发生了什么，也不知道下一步该干什么。
//
// 这里的口径：
//   summary —— 中文结论 + 一句"你现在该做什么"，放浮层，够短能一眼读完；
//   detail  —— 原文（去 ANSI、去多余空行），进了通知中心再看，不丢信息。
//
// 放在 shared 是因为它只是文本到文本的映射，主进程将来要复用同一套话术也不必另写一份。
export interface FailureCopy {
  /** 浮层上展示的那一句。 */
  summary: string
  /** 原文，给通知详情用。翻译会丢细节，原文不丢。 */
  detail?: string
}

interface Rule {
  test: RegExp
  summary: string
  advice?: string
}

// 顺序即优先级：越具体的放越前。"Free usage exceeded" 里也含 "exceeded"，
// 不能让它被后面更宽的网络/超时规则抢走。
const RULES: Rule[] = [
  {
    test: /Windows interactive mode requires console input/i,
    summary: 'AtomCode 登录要交互式终端，墨桥在后台调起时没有终端可用。',
    advice: '请在 PowerShell 或 Windows Terminal 里手动执行 atomcode login，浏览器授权完成后回本页点「重新检测」。',
  },
  {
    test: /MobaXterm|winpty/i,
    summary: 'AtomCode 需要在真终端里运行，当前环境没有可用控制台。',
    advice: '换用 Windows Terminal / PowerShell 手动执行 atomcode login。',
  },
  {
    // 上游网关把拒绝伪装成助手回复（"参数错误"/"三方请求失败: …"），转发口还原成错误后才走到这里。
    test: /参数错误|三方请求失败/,
    summary: '上游拒绝了这个模型：多半是套餐未启用或模型已下线（目录与权益不同步）。',
    advice: '回墨桥 AtomCode 页点「刷新目录」重新校验，可用性通过后再写入。',
  },
  {
    test: /Free usage exceeded|quota|时间窗口用量|额度不足|额度已用尽/i,
    summary: '上游额度用尽了，这一步被上游拒绝。',
    advice: '换个时间段再试，或在本页查看各模型的具体报错。',
  },
  {
    test: /not available in your country|地区|region/i,
    summary: '该模型在当前地区不可用。',
  },
  {
    test: /401|unauthorized|invalid.*(api )?key|鉴权失败|Authentication/i,
    summary: '鉴权没通过（Key 无效或过期）。',
    advice: '检查 Key 是否复制完整，必要时重新生成一个。',
  },
  {
    test: /403|forbidden/i,
    summary: '上游拒绝了这个请求（权限不足）。',
  },
  {
    test: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up/i,
    summary: '连不上上游（网络或代理问题）。',
    advice: '检查本机网络与代理设置；走代理时确认「系统代理」已开启。',
  },
  {
    test: /ETIMEDOUT|timeout|超时/i,
    summary: '请求超时了。',
    advice: '上游此刻可能很慢，稍后重试；也可以在设置里把检测超时调大。',
  },
  {
    test: /ENOENT|no such file|找不到|未检测到/i,
    summary: '本机没找到对应的文件或程序。',
    advice: '确认客户端已安装并至少启动过一次。',
  },
  {
    test: /EADDRINUSE|address already in use|端口.*占用/i,
    summary: '端口被占用了。',
    advice: '在设置里换一个本地端口，保存后会自动重启本地服务。',
  },
]

/** 去掉 ANSI 转义与多余空白：CLI 输出带颜色码，直接显示会是一堆乱码方块。 */
export function cleanOutput(raw: string): string {
  return String(raw || '')
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 没匹配到规则时的兜底：取第一行，太长就截断——浮层不是给人读长文的地方。 */
function firstLine(text: string): string {
  const line = text.split('\n').map(part => part.trim()).filter(Boolean)[0] || text
  return line.length > 90 ? line.slice(0, 90) + '…' : line
}

/**
 * @param raw 原始报错（含 CLI 输出、HTTP 错误体）
 * @param fallback 原文为空时的兜底文案
 */
export function describeFailure(raw: unknown, fallback = '操作失败'): FailureCopy {
  const text = cleanOutput(typeof raw === 'string' ? raw : String((raw as Error)?.message ?? raw ?? ''))
  if (!text || text === 'undefined' || text === 'null') return { summary: fallback }
  const rule = RULES.find(item => item.test.test(text))
  if (!rule) return { summary: firstLine(text), detail: text }
  return { summary: rule.advice ? `${rule.summary}${rule.advice}` : rule.summary, detail: text }
}
