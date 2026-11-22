/**
 * identity.test.ts：账号一致性校验单测。
 *
 * 只有实际 uin 非空且等于配置 selfId 才放行。缺失/空白身份是 missing，
 * 不能当成“还没拉到所以先上线”的理由；不一致按原事故处置顺序拒绝。
 *
 * 判定与拒绝动作都是纯逻辑（生命周期控制器只做接线），单测不 import
 * koishi 运行时（docs/guides/development.md 单测边界）。
 */
import { describe, expect, it, vi } from "vitest";
import {
    evaluateIdentity,
    type IdentityMismatchSink,
    rejectIdentityMismatch,
} from "../../../src/bot/lifecycle.js";

describe("evaluateIdentity", () => {
    it("实际 uin 缺失 → missing（等待补拉，不放行）", () => {
        expect(evaluateIdentity("10001", undefined)).toEqual({ kind: "missing" });
    });

    it("实际 uin 为空串 → missing", () => {
        expect(evaluateIdentity("10001", "")).toEqual({ kind: "missing" });
    });

    it("实际 uin 为空白 → missing", () => {
        expect(evaluateIdentity("10001", " \t ")).toEqual({ kind: "missing" });
    });

    it("实际 uin 与配置 selfId 一致 → verified（携带 uin）", () => {
        expect(evaluateIdentity("10001", "10001")).toEqual({
            kind: "verified",
            uin: "10001",
        });
    });

    it("实际 uin 与配置 selfId 不一致 → mismatch（携带两侧 uin 供文案插值）", () => {
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
