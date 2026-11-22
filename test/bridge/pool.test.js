import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWithConcurrency } from '../../src/service/domain/pool.ts';

test('并发池：同时在跑的 worker 不超过 limit，且全部条目都被处理', async () => {
  let running = 0;
  let peak = 0;
  const done = [];
  const items = Array.from({ length: 20 }, (_, i) => i);
  await runWithConcurrency(items, 5, async item => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 10));
    running -= 1;
    done.push(item);
  });
  assert.ok(peak <= 5, `峰值并发 ${peak} 不应超过 5`);
  assert.equal(done.length, 20);
  assert.deepEqual([...done].sort((a, b) => a - b), items);
});

test('并发池：limit 大于条目数时收敛为条目数；空清单直接完成', async () => {
  let peak = 0;
  let running = 0;
  await runWithConcurrency([1, 2, 3], 50, async () => {
    running += 1; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running -= 1;
  });
  assert.ok(peak <= 3, `峰值并发 ${peak} 不应超过条目数 3`);
  await runWithConcurrency([], 5, async () => { throw new Error('不应被调用'); });
});

test('并发池：worker 抛错会向上传播，但调度已覆盖全部条目', async () => {
  // 语义：池不吞异常——探测链路在 worker 内部把单个模型的失败消化成结果，
  // 所以池只负责调度。这里故意不消化，验证异常按 Promise.all 语义向上抛，
  // 且在抛出前其余条目已被调度执行过（不会因一个失败漏跑剩下的）。
  const handled = [];
  await assert.rejects(
    () => runWithConcurrency([1, 2, 3, 4], 2, async item => {
      if (item === 2 || item === 4) throw new Error(`boom-${item}`);
      handled.push(item);
    }),
    /boom-/,
  );
  assert.deepEqual(handled.sort(), [1, 3]);
});

test('并发池：limit 收敛到至少 1（非法值不产生 0 worker 卡死）', async () => {
  const seen = [];
  await runWithConcurrency([1, 2], 0, async item => { seen.push(item); });
  assert.equal(seen.length, 2);
});
