/**
 * heartbeat.test.ts：HeartbeatMonitor 单测（自 driver.ts 拆出的失联判定）。
 *
 * 覆盖：未超时不触发 / 超时触发（以 seenAt 为准）/ seenAt=0 用 spawnAt 兜底 /
 * 无参照（从未收到也从未 spawn）不触发 / 边界（恰等于超时阈值不触发，
 * 严格大于才触发）/ stopping/failed/restarting 暂停判定 / start 幂等 /
 * stop 停止轮询。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    HeartbeatMonitor,
    type HeartbeatSource,
} from "../../../../src/runtime/driver/supervision.js";
import type { DriverState } from "../../../../src/runtime/driver/types.js";

/** 固定初始时钟（fake timers 下 Date.now 从该值推进）。 */
const T0 = 1_000_000;

/** 构造采样源（缺省 ready 状态 + seenAt/spawnAt = T0）。 */
function createSource(overrides: Partial<HeartbeatSource> = {}): HeartbeatSource {
    return {
        seenAt: () => T0,
        spawnAt: () => T0,
        state: () => "ready" as DriverState,
        ...overrides,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("HeartbeatMonitor", () => {
    it("未超时 → 不触发 onStale", () => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 999);
        monitor.check();
        expect(onStale).not.toHaveBeenCalled();
    });

    it("超时（以 seenAt 为准）→ 触发 onStale", () => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 1_001);
        monitor.check();
        expect(onStale).toHaveBeenCalledTimes(1);
    });

    it("边界：恰等于超时阈值（> 严格大于）→ 不触发", () => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 1_000);
        monitor.check();
        expect(onStale).not.toHaveBeenCalled();
    });

    it("seenAt=0 → 用 spawnAt 兜底判定", () => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource({ seenAt: () => 0, spawnAt: () => T0 }), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 1_001);
        monitor.check();
        expect(onStale).toHaveBeenCalledTimes(1);
    });

    it("无参照（seenAt=0 且 spawnAt=0）→ 不触发", () => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource({ seenAt: () => 0, spawnAt: () => 0 }), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 5_000);
        monitor.check();
        expect(onStale).not.toHaveBeenCalled();
    });

    it.each(["stopping", "failed", "restarting"] as const)("状态 %s → 暂停失联判定", (state) => {
        const onStale = vi.fn();
        const monitor = new HeartbeatMonitor(createSource({ state: () => state }), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        vi.useFakeTimers();
        vi.setSystemTime(T0 + 5_000);
        monitor.check();
        expect(onStale).not.toHaveBeenCalled();
    });

    it("start 幂等：重复 start 只保留一个 timer", () => {
        vi.useFakeTimers();
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale: vi.fn(),
        });
        monitor.start();
        monitor.start();
        expect(vi.getTimerCount()).toBe(1);
        monitor.stop();
    });

    it("stop 后不再轮询", () => {
        const onStale = vi.fn();
        vi.useFakeTimers();
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        monitor.start();
        monitor.stop();
        vi.advanceTimersByTime(2_000);
        expect(onStale).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("start 后按间隔轮询，超时累积触发 onStale", () => {
        const onStale = vi.fn();
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const monitor = new HeartbeatMonitor(createSource(), {
            intervalMs: 100,
            timeoutMs: 1_000,
            onStale,
        });
        monitor.start();
        vi.advanceTimersByTime(1_100); // 11 次 tick，第 11 次（now-T0=1100>1000）触发
        expect(onStale).toHaveBeenCalledTimes(1);
        monitor.stop();
    });
});
