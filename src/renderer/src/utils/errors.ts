// 失败反馈的渲染层出口：翻译规则本身在 shared/failure.ts（纯函数），
// 这里只负责把它接到浮层 + 通知中心上。
import { note } from '../composables/useService'
import { describeFailure } from '@shared/failure'

export { cleanOutput, describeFailure } from '@shared/failure'
export type { FailureCopy } from '@shared/failure'

/**
 * 失败统一出口：浮层上只说一句中文，原文进通知中心。
 * 所有页面的 catch 都走这里，避免同一个错误在两处写成两种样子。
 * source 用于通知中心的来源标识（日日新 / AtomCode…），系统级错误不标。
 */
export function notifyFailure(raw: unknown, options: { fallback?: string, prefix?: string, source?: string } = {}) {
  const copy = describeFailure(raw, options.fallback)
  note((options.prefix || '') + copy.summary, 'error', { detail: copy.detail, source: options.source })
}
