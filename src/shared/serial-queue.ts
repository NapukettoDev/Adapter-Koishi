/**
 * serial-queue.ts：per-key 串行队列（自 database/index.ts 拆出）。
 *
 * 职责：同 key 任务串行排队（前序失败不阻塞后续），异 key 并行；
 * 链尾完成后自动清理引用（防 Map 无限增长）。通用实现，与数据库无关。
 */
/** per-key 串行队列（同 key 串行、异 key 并行）。 */
export class SerialQueue {
    /** key → 当前链尾 promise。 */
    private readonly chains = new Map<string, Promise<void>>();

    /**
     * 排队执行任务：同 key 串行（等待前序完成，前序失败不阻塞），
     * 异 key 并行。返回 promise 在任务完成（或跳过）后 resolve，绝不 reject。
     */
    enqueue(key: string, task: () => Promise<void>): Promise<void> {
        const prev = this.chains.get(key) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(task);
        this.chains.set(key, next);
        // 链尾完成后清理（无新任务排队时删除引用，防 Map 无限增长）
        // ⚠️ 清理链前接 .catch 吞掉任务失败：next.finally() 的派生 promise
        // 会随 next 一起 reject，被 void 丢弃 → unhandled rejection
        void next
            .catch(() => undefined)
            .finally(() => {
                if (this.chains.get(key) === next) {
                    this.chains.delete(key);
                }
            });
        return next;
    }
}
