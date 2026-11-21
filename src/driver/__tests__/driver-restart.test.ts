/**
 * driver-restart.test.ts：NapukettoDriver 重启 + 心跳失联单测。
 */
import { describe, expect, it, vi } from "vitest";
import { createHarness, flush } from "../test-utils.js";

describe("NapukettoDriver 重启", () => {
    it("崩溃 → 退避重启 → ready 重置计数", async () => {
        vi.useFakeTimers();
        try {
            const onReady = vi.fn();
            const { driver, spawns, emit } = createHarness({ onReady });
            driver.start();
            await flush();
            expect(spawns.length).toBe(1);

            // 第 1 轮崩溃（code=1）→ restarting，退避 100ms
            spawns[0]?.emitExit(1, null);
            expect(driver.currentState).toBe("restarting");
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);

            // 第 2 轮 ready → restartCount 重置 0
            emit("ready");
            await flush();
            expect(driver.currentState).toBe("ready");
            expect(driver.restartAttempts).toBe(0);
            driver.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it("崩溃次数达上限 → failed + onError", async () => {
        vi.useFakeTimers();
        try {
            const onError = vi.fn();
            const { driver, spawns } = createHarness(
                { onError },
                {
                    restart: { maxRetries: 1, backoffMs: 100 },
                },
            );
            driver.start();
            await flush();

            // 第 1 次崩溃 → 重启
            spawns[0]?.emitExit(1, null);
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);

            // 第 2 次崩溃 → 已达上限 → failed
            spawns[1]?.emitExit(1, null);
            expect(driver.currentState).toBe("failed");
            expect(onError).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("心跳失联（spawn 后 45s 无消息）→ kill + 重启", async () => {
        vi.useFakeTimers();
        try {
            const onExit = vi.fn();
            const { driver, spawns } = createHarness({ onExit });
            driver.start();
            await flush();
            expect(spawns.length).toBe(1);

            // spawn 后 45s 内无任何消息 → 失联（兜 dlopen/登录卡死）
            await vi.advanceTimersByTimeAsync(46_000);
            expect(spawns[0]?.killed).toBe(true);
            // 失联 → handleChildExit(stale) → 重启调度
            await vi.advanceTimersByTimeAsync(150);
            expect(spawns.length).toBe(2);
            // SIGTERM 后旧进程的 exit 可能晚于下一轮 spawn。
            spawns[0]?.emitExit(null, "SIGTERM");
            expect(onExit).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ reason: "stale" }),
            );
            expect(driver.currentState).toBe("booting");
            driver.stop();
            spawns[1]?.emitExit(0, null);
        } finally {
            vi.useRealTimers();
        }
    });

    it("心跳失联后收到消息则不再误判", async () => {
        vi.useFakeTimers();
        try {
            const { driver, spawns, emit } = createHarness();
            driver.start();
            await flush();
            // 30s 时收到一条 status（seenAt 更新）
            await vi.advanceTimersByTimeAsync(30_000);
            emit("sessioning");
            // 再过 20s（<45s 阈值）不误判
            await vi.advanceTimersByTimeAsync(20_000);
            expect(spawns[0]?.killed).toBe(false);
            driver.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
