/**
 * identity.test.ts：checkIdentity 账号一致性校验单测（2026-09-10 补齐）。
 *
 * 覆盖 2026-08-20 生产事故根治分支三例：①实际 uin 缺失/空 → 放行（不
 * offline）②与配置 selfId 一致 → 放行 ③不一致 → 拒绝（置闸门 + 可操作
 * 提示 + 停 driver + 拒绝上线，顺序保持原实现）。
 *
 * checkIdentity 副作用挂 koishi Bot 基类，单测不可 import koishi
 * （docs/guides/development.md 单测边界）——被测对象是拆出的纯逻辑
 * （utils/identity.ts）：evaluateIdentity
 * 纯判定 + rejectIdentityMismatch 注入式拒绝动作；bot.ts 的 checkIdentity
 * 只剩组装（接线注入 logger/identityMismatch/driver/offline）。
 */
import { describe, expect, it, vi } from "vitest";
import {
    evaluateIdentity,
    type IdentityMismatchSink,
    rejectIdentityMismatch,
} from "../utils/identity.js";

describe("evaluateIdentity", () => {
    it("① 实际 uin 缺失（未拉到 selfInfo）→ 放行", () => {
        expect(evaluateIdentity("10001", undefined)).toEqual({ kind: "allow" });
    });

    it("① 实际 uin 为空串 → 放行", () => {
        expect(evaluateIdentity("10001", "")).toEqual({ kind: "allow" });
    });

    it("② 实际 uin 与配置 selfId 一致 → 放行", () => {
        expect(evaluateIdentity("10001", "10001")).toEqual({ kind: "allow" });
    });

    it("③ 实际 uin 与配置 selfId 不一致 → mismatch（携带两侧 uin 供文案插值）", () => {
        expect(evaluateIdentity("10001", "20002")).toEqual({
            kind: "mismatch",
            configSelfId: "10001",
            actualUin: "20002",
        });
    });
});

describe("rejectIdentityMismatch", () => {
    /** 构造 mock sink（传实现推断类型：sink 赋值类型干净，断言用原始引用）。 */
    function makeSink() {
        const onError = vi.fn((_message: string, ..._args: unknown[]) => {});
        const setMismatch = vi.fn(() => {});
        const stopDriver = vi.fn(() => {});
        const offline = vi.fn((_error: Error) => {});
        const sink: IdentityMismatchSink = { onError, setMismatch, stopDriver, offline };
        return { sink, onError, setMismatch, stopDriver, offline };
    }

    it("③ 拒绝序列完整：置闸门 → error 提示 → 停 driver → 拒绝上线", () => {
        const { sink, onError, setMismatch, stopDriver, offline } = makeSink();
        const decision = evaluateIdentity("10001", "20002");
        if (decision.kind !== "mismatch") {
            throw new Error("前置失败：应判定为 mismatch");
        }
        rejectIdentityMismatch(decision, sink);
        expect(setMismatch).toHaveBeenCalledTimes(1);
        expect(stopDriver).toHaveBeenCalledTimes(1);
        expect(offline).toHaveBeenCalledTimes(1);
        // 顺序有语义：先置闸门（dispatch 拒派发生效）再处置；
        // noUncheckedIndexedAccess 缺项取 +Inf 使断言自然失败
        const callOrder = (mock: { invocationCallOrder: number[] }): number =>
            mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
        expect(callOrder(setMismatch.mock)).toBeLessThan(callOrder(onError.mock));
        expect(callOrder(onError.mock)).toBeLessThan(callOrder(stopDriver.mock));
        expect(callOrder(stopDriver.mock)).toBeLessThan(callOrder(offline.mock));
    });

    it("③ error 提示带两侧 uin 插值（改 selfId=%s 或用 %s 重扫）", () => {
        const { sink, onError } = makeSink();
        rejectIdentityMismatch(
            { kind: "mismatch", configSelfId: "10001", actualUin: "20002" },
            sink,
        );
        expect(onError).toHaveBeenCalledTimes(1);
        const [format, ...args] = onError.mock.calls[0] ?? [];
        expect(String(format)).toContain("账号不一致：配置 selfId=%s，实际登录 uin=%s");
        expect(String(format)).toContain("请把插件配置 selfId 改成 %s，或改用 %s 重新扫码登录");
        expect(args).toEqual(["10001", "20002", "20002", "10001"]);
    });

    it("③ offline 收到 Error，message 含两侧 uin（拒绝上线的失败原因）", () => {
        const { sink, offline } = makeSink();
        rejectIdentityMismatch(
            { kind: "mismatch", configSelfId: "10001", actualUin: "20002" },
            sink,
        );
        const [error] = offline.mock.calls[0] ?? [];
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("账号不一致：配置 selfId=10001，实际登录 uin=20002");
    });
});
