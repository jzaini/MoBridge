// 写入客户端后的展示名。
// 渠道前缀（OC · / AC · / SN ·）在服务层可能已经加过：上游 id 与展示名不是一回事，
// 页面再盲目拼一次就会出现「AC · AC · …」这种双前缀。这里统一兜一次。
export function clientName(prefix: string, value: string | undefined | null): string {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.startsWith(prefix) ? text : prefix + text
}
