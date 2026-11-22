// 简易并发池：最多 limit 个 worker 同时跑，跑完一个领下一个。
// 探测链路共用这一份：OpenCode 的整轮检测、日日新的逐模型直连、AtomCode 的可用性探测。
// 语义约束：
//   - 结果顺序无关（调用方各自按 model 键归位）；
//   - worker 抛错不中断整池——单个模型的失败不该拖死其它模型的判定；
//     错误由 worker 内部消化成结果，池只负责调度。
//   - limit 会被收敛到 [1, items.length]，空清单直接返回。
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  const width = Math.max(1, Math.min(limit, items.length));
  const queue = items.slice();
  let next = 0;
  const runners = Array.from({ length: width }, async () => {
    while (next < queue.length) {
      const index = next++;
      await worker(queue[index], index);
    }
  });
  await Promise.all(runners);
}
