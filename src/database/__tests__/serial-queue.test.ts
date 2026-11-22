/**
 * serial-queue.test.ts：SerialQueue 单测（自 database/index.ts 拆出）。
 *
 * 覆盖：同 key 串行 / 异 key 并行 / 前序失败不阻塞后续（前序 reject 被吞）/
 * 当前任务失败返回 promise 照常 reject / 链尾完成后清理（防 Map 无限增长）。
 */
import { describe, expect, it } from "vitest";
import { SerialQueue } from "../../shared/serial-queue.js";

/** 冲刷微任务队列（finally 清理链需多轮才到）。 */
async function flushMicrotasks(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
    }
}

describe("SerialQueue", () => {
    it("同 key 串行：按入队顺序执行", async () => {
        const order: string[] = [];
        const queue = new SerialQueue();
        const t1 = queue.enqueue("k", async () => {
            order.push("a-start");
            await Promise.resolve();
            order.push("a-end");
        });
        const t2 = queue.enqueue("k", async () => {
            order.push("b");
        });
        await t1;
        await t2;
        expect(order).toEqual(["a-start", "a-end", "b"]);
    });

    it("异 key 并行：互不等待", async () => {
        const order: string[] = [];
        const queue = new SerialQueue();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const t1 = queue.enqueue("k1", async () => {
            order.push("a-start");
            await gate;
            order.push("a-end");
        });
        const t2 = queue.enqueue("k2", async () => {
            order.push("b");
        });
        await t2; // k2 不等 k1 的 gate
        expect(order).toEqual(["a-start", "b"]);
        release();
        await t1;
        expect(order).toEqual(["a-start", "b", "a-end"]);
    });

    it("前序失败不阻塞后续：前序 reject 被吞，后续照常执行", async () => {
        const order: string[] = [];
        const queue = new SerialQueue();
        const t1 = queue.enqueue("k", async () => {
            throw new Error("boom");
        });
        const assertion = expect(t1).rejects.toThrow("boom");
        const t2 = queue.enqueue("k", async () => {
            order.push("b");
        });
        await assertion;
        await t2;
        expect(order).toEqual(["b"]);
    });

    it("同 key 队列返回的 promise 传播当前任务失败", async () => {
        const queue = new SerialQueue();
        const t1 = queue.enqueue("k", async () => undefined);
        await t1;
        const t2 = queue.enqueue("k", async () => {
            throw new Error("second-fail");
        });
        await expect(t2).rejects.toThrow("second-fail");
    });

    it("链尾完成后清理：多次排队后内部 Map 为空", async () => {
        const queue = new SerialQueue();
        await queue.enqueue("k", async () => undefined);
        await queue.enqueue("k", async () => undefined);
        await queue.enqueue("other", async () => undefined);
        await flushMicrotasks();
        const chains = (queue as unknown as { chains: Map<string, unknown> }).chains;
        expect(chains.size).toBe(0);
    });

    it("清理后同 key 新任务立即执行（不残留旧链尾串行）", async () => {
        const order: string[] = [];
        const queue = new SerialQueue();
        await queue.enqueue("k", async () => {
            order.push("first");
        });
        await flushMicrotasks();
        await queue.enqueue("k", async () => {
            order.push("second");
        });
        expect(order).toEqual(["first", "second"]);
    });
});
