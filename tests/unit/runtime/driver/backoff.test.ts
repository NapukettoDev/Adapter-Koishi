/**
 * backoff.test.ts：指数退避纯函数单测。
 */
import { describe, expect, it, vi } from "vitest";
import { backoffDelay, RestartScheduler } from "../../../../src/runtime/driver/supervision.js";

describe("backoffDelay", () => {
    it("第 1 次 = base", () => {
        expect(backoffDelay(1, 1_000, 2)).toBe(1_000);
    });

    it("指数增长：1000/2000/4000", () => {
        expect(backoffDelay(1, 1_000, 2)).toBe(1_000);
        expect(backoffDelay(2, 1_000, 2)).toBe(2_000);
        expect(backoffDelay(3, 1_000, 2)).toBe(4_000);
    });

    it("maxMs 封顶", () => {
        expect(backoffDelay(5, 1_000, 2, 4_000)).toBe(4_000);
    });

    it("attempt=0 兜底 = base", () => {
        expect(backoffDelay(0, 500, 3)).toBe(500);
    });
});

describe("RestartScheduler", () => {
    it("重复调度只保留最新计时器，不会 spawn 两次", async () => {
        vi.useFakeTimers();
        try {
            const scheduler = new RestartScheduler({ backoffMs: 100, backoffFactor: 2 });
            const first = vi.fn();
            const second = vi.fn();
            scheduler.schedule(first);
            scheduler.schedule(second);
            await vi.advanceTimersByTimeAsync(100);
            expect(first).not.toHaveBeenCalled();
            expect(second).toHaveBeenCalledOnce();
            expect(scheduler.attempts).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("cancel 能阻止已安排的重启并清空计时器", async () => {
        vi.useFakeTimers();
        try {
            const scheduler = new RestartScheduler({ backoffMs: 100 });
            const spawn = vi.fn();
            scheduler.schedule(spawn);
            scheduler.cancel();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(spawn).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
