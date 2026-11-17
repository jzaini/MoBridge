// 步骤栏的数据形状：三个接入页共用同一份定义。
// 放在 utils 而不是组件里，是因为 <script setup> 不导出类型，
// 页面要造 steps 数组就得 import 一个能导出类型的模块。
export interface RailStep {
  /** 步骤标识，页面用它决定"当前该展示哪块内容"。 */
  key: string
  label: string
  /** 一句话说明这一步现在什么情况（已就绪 / 几个可用 / 还差什么）。 */
  hint?: string
  state: 'done' | 'current' | 'error' | 'todo'
}
