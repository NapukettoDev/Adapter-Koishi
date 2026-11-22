/**
 * failure-reporter 单测（docs/internals/bot.md「数据库预热」）。
 *
 * 覆盖：首次完整告警 / 同因重复只计数 / 不同平台、不同错误码或消息各自保留证据 /
 * 冷却时间与重复阈值触发的摘要 / 日志后端异常不反噬调用方。
 */

import { describe, expect, it, vi } from "vitest";
import { PreheatFailureReporter } from "../../../src/bot/failure-reporter.js";

/** 构造报告器并暴露可控时钟。 */
function makeReporter(
    options: { repeatInterval?: number; cooldownMs?: number; warn?: ReturnType<typeof vi.fn> } = {},
) {
    const warn = options.warn ?? vi.fn();
    const warnSink = warn as unknown as (message: string, ...args: unknown[]) => void;
    let now = 0;
    const reporter = new PreheatFailureReporter({
        warn: warnSink,
        now: () => now,
        ...(options.repeatInterval !== undefined ? { repeatInterval: options.repeatInterval } : {}),
        ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
    });
    return {
        reporter,
        warn,
        advance(ms: number): void {
            now += ms;
        },
    };
}

describe("PreheatFailureReporter", () => {
    it("首次失败输出完整证据（操作、平台、记录键、错误对象）", () => {
        const { reporter, warn } = makeReporter();
        const error = new Error("boom");
        reporter.report("channel", "onebot", "g1", error);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[1]).toBe("channel");
        expect(warn.mock.calls[0]?.[2]).toBe("onebot");
        expect(warn.mock.calls[0]?.[3]).toBe("g1");
        // 最后一个是原始错误对象，保留堆栈等证据
        expect(warn.mock.calls[0]?.at(-1)).toBe(error);
    });

    it("同因重复失败只计数，不重复刷屏", () => {
        const { reporter, warn } = makeReporter();
        reporter.report("channel", "onebot", "g1", new Error("boom"));
        reporter.report("channel", "onebot", "g2", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("不同错误消息各自保留证据", () => {
        const { reporter, warn } = makeReporter();
        reporter.report("channel", "onebot", "g1", new Error("boom-1"));
        reporter.report("channel", "onebot", "g2", new Error("boom-2"));
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("不同平台各自保留证据", () => {
        const { reporter, warn } = makeReporter();
        reporter.report("channel", "onebot", "g1", new Error("boom"));
        reporter.report("channel", "qq", "g1", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("不同操作各自保留证据", () => {
        const { reporter, warn } = makeReporter();
        reporter.report("channel", "onebot", "g1", new Error("boom"));
        reporter.report("user", "onebot", "u1", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("有错误码时忽略带记录键的消息，同码归并", () => {
        const { reporter, warn } = makeReporter();
        const first = new Error("UNIQUE constraint failed: channel.id = g1");
        (first as Error & { code?: string }).code = "SQLITE_CONSTRAINT";
        const second = new Error("UNIQUE constraint failed: channel.id = g2");
        (second as Error & { code?: string }).code = "SQLITE_CONSTRAINT";
        reporter.report("channel", "onebot", "g1", first);
        reporter.report("channel", "onebot", "g2", second);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("冷却时间到后再次输出摘要（保留累计次数与首末记录键）", () => {
        const { reporter, warn, advance } = makeReporter({ cooldownMs: 1000 });
        reporter.report("channel", "onebot", "g1", new Error("boom"));
        reporter.report("channel", "onebot", "g2", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(1);
        advance(1000);
        reporter.report("channel", "onebot", "g3", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1]?.[2]).toBe(3);
        expect(warn.mock.calls[1]?.[4]).toBe("g3");
        expect(warn.mock.calls[1]?.[6]).toBe("g1");
    });

    it("重复阈值到后输出摘要（不依赖时间）", () => {
        const { reporter, warn } = makeReporter({ repeatInterval: 3, cooldownMs: 60_000 });
        reporter.report("channel", "onebot", "g1", new Error("boom"));
        reporter.report("channel", "onebot", "g2", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(1);
        reporter.report("channel", "onebot", "g3", new Error("boom"));
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1]?.[2]).toBe(3);
    });

    it("日志后端抛错不反噬调用方", () => {
        const warn = vi.fn(() => {
            throw new Error("logger down");
        });
        const { reporter } = makeReporter({ warn });
        expect(() => reporter.report("channel", "onebot", "g1", new Error("boom"))).not.toThrow();
    });
});
