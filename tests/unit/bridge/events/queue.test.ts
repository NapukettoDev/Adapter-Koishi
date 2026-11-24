/**
 * queue.test.ts：按频道有界队列。
 *
 * 覆盖：同频道串行 / 异频道并行 / 每频道与全局饱和降级 / 取消在途与排队 /
 * 取消后旧任务不驱动新代次队列。
 */
import { describe, expect, it, vi } from "vitest";
import { BoundedChannelQueue } from "../../../../src/bridge/events/queue.js";

function deferred() {
    return Promise.withResolvers<void>();
}

async function flushMicrotasks(rounds = 4): Promise<void> {
    for (let index = 0; index < rounds; index += 1) {
        await Promise.resolve();
    }
}

describe("BoundedChannelQueue", () => {
    it("同频道串行：按入队顺序执行", async () => {
        const order: string[] = [];
        const queue = new BoundedChannelQueue();
        const first = deferred();
        const a = queue.enqueue("g1", {
            run: async () => {
                order.push("a-start");
                await first.promise;
                order.push("a-end");
            },
        });
        const b = queue.enqueue("g1", {
            run: async () => {
                order.push("b");
            },
        });
        expect(a).toBe("queued");
        expect(b).toBe("queued");
        await flushMicrotasks();
        expect(order).toEqual(["a-start"]);
        first.resolve();
        await vi.waitFor(() => expect(order).toEqual(["a-start", "a-end", "b"]));
        expect(queue.pending).toBe(0);
        expect(queue.running).toBe(0);
    });

    it("异频道并行：慢频道不阻塞其他频道", async () => {
        const order: string[] = [];
        const gate = deferred();
        const queue = new BoundedChannelQueue();
        queue.enqueue("slow", {
            run: async () => {
                order.push("slow-start");
                await gate.promise;
                order.push("slow-end");
            },
        });
        queue.enqueue("fast", {
            run: async () => {
                order.push("fast");
            },
        });
        await vi.waitFor(() => expect(order).toEqual(["slow-start", "fast"]));
        gate.resolve();
        await vi.waitFor(() => expect(order).toEqual(["slow-start", "fast", "slow-end"]));
    });

    it("每频道饱和：立即执行并回调诊断，队列保持有界", async () => {
        const overflow = vi.fn();
        const queue = new BoundedChannelQueue({
            maxPendingPerChannel: 1,
            maxPendingTotal: 10,
            onOverflow: overflow,
        });
        const gate = deferred();
        const order: string[] = [];
        queue.enqueue("g1", {
            run: async () => {
                order.push("running");
                await gate.promise;
            },
        });
        queue.enqueue("g1", {
            run: async () => {
                order.push("queued");
            },
        });
        const result = queue.enqueue("g1", {
            run: async () => {
                order.push("overflow");
            },
        });
        expect(result).toBe("overflow");
        expect(overflow).toHaveBeenCalledWith("g1", "channel");
        // 饱和任务立即执行，不进入待派发队列。
        expect(queue.pending).toBe(1);
        await vi.waitFor(() => expect(order).toContain("overflow"));
        expect(order).not.toContain("queued");
        gate.resolve();
        await vi.waitFor(() => expect(order).toEqual(["running", "overflow", "queued"]));
    });

    it("全局饱和：即使单频道未满也降级并诊断", async () => {
        const overflow = vi.fn();
        const queue = new BoundedChannelQueue({
            maxPendingPerChannel: 10,
            maxPendingTotal: 1,
            onOverflow: overflow,
        });
        const gate = deferred();
        queue.enqueue("g1", {
            run: async () => {
                await gate.promise;
            },
        });
        // g1 已有 1 个待执行任务，全局积压达到上限；g2 的首个任务立即运行，
        // g2 的第二个任务因全局积压已满而降级。
        queue.enqueue("g1", { run: async () => undefined });
        queue.enqueue("g2", { run: async () => undefined });
        const result = queue.enqueue("g2", { run: async () => undefined });
        expect(result).toBe("overflow");
        expect(overflow).toHaveBeenCalledWith("g2", "total");
        gate.resolve();
        await vi.waitFor(() => expect(queue.pending).toBe(0));
    });

    it("取消：中止运行中的 signal、丢弃排队任务并调用其清理", async () => {
        const queue = new BoundedChannelQueue();
        const gate = deferred();
        const cancelled = vi.fn();
        const runningSignals: AbortSignal[] = [];
        queue.enqueue("g1", {
            run: async (signal) => {
                runningSignals.push(signal);
                await gate.promise;
            },
        });
        queue.enqueue("g1", { run: async () => undefined, cancel: cancelled });
        expect(queue.pending).toBe(1);
        queue.cancelAll(new Error("relogin"));
        expect(queue.pending).toBe(0);
        expect(cancelled).toHaveBeenCalledOnce();
        expect(runningSignals[0]?.aborted).toBe(true);
        gate.resolve();
        await flushMicrotasks(8);
        expect(queue.running).toBe(0);
    });

    it("取消后旧任务结束不驱动新代次队列", async () => {
        const queue = new BoundedChannelQueue();
        const order: string[] = [];
        const gate = deferred();
        queue.enqueue("g1", {
            run: async () => {
                order.push("old-start");
                await gate.promise;
                order.push("old-end");
            },
        });
        queue.cancelAll();
        queue.enqueue("g1", {
            run: async () => {
                order.push("new");
            },
        });
        await vi.waitFor(() => expect(order).toEqual(["old-start", "new"]));
        gate.resolve();
        await flushMicrotasks(8);
        expect(order).toEqual(["old-start", "new", "old-end"]);
        expect(queue.pending).toBe(0);
    });
});
