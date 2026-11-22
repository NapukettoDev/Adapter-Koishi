/**
 * policy 单测（docs/internals/bot.md「数据库预热」）。
 *
 * 覆盖：静态值直用 / Eval 与非法值 deferred / 纯函数按不可变 session 字段求值 /
 * 读取 user 等延迟字段、改写 session、抛错或返回非法类型时 deferred / async 函数不调用。
 */

import type { Computed } from "koishi";
import { describe, expect, it } from "vitest";
import { isAssignPolicy, isAuthorizePolicy, resolvePolicy } from "../../../src/bot/policy.js";

/** 只含构造期已定字段的 session 桩。 */
const session = {
    type: "message",
    selfId: "10001",
    platform: "onebot",
    userId: "20001",
    channelId: "g1",
    guildId: "g1",
    isDirect: false,
};

describe("resolvePolicy", () => {
    it("静态 boolean / natural number → resolved", () => {
        expect(resolvePolicy(true, session, isAssignPolicy)).toEqual({
            kind: "resolved",
            value: true,
        });
        expect(resolvePolicy(0, session, isAuthorizePolicy)).toEqual({
            kind: "resolved",
            value: 0,
        });
        expect(resolvePolicy(3, session, isAuthorizePolicy)).toEqual({
            kind: "resolved",
            value: 3,
        });
    });

    it("非法静态值 → deferred", () => {
        expect(resolvePolicy("true" as unknown as boolean, session, isAssignPolicy)).toEqual({
            kind: "deferred",
        });
        expect(resolvePolicy(1.5, session, isAuthorizePolicy)).toEqual({ kind: "deferred" });
        expect(resolvePolicy(-1, session, isAuthorizePolicy)).toEqual({ kind: "deferred" });
    });

    it("Eval 表达式对象 → deferred（不猜延迟字段求值环境）", () => {
        // biome-ignore lint/style/useNamingConvention: minato Eval 表达式使用 `$` 键
        const source = { $: "session.channelId" } as unknown as Computed<number>;
        expect(resolvePolicy(source, session, isAuthorizePolicy)).toEqual({ kind: "deferred" });
    });

    it("纯函数读取不可变 session 字段 → 按真实字段求值", () => {
        const source = (value: typeof session) =>
            value.channelId === "g1" && value.isDirect === false ? 3 : 1;
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "resolved", value: 3 });
    });

    it("真实 Session 的访问器字段先固化到快照 → 仍可安全求值", () => {
        const accessorSession = {
            get channelId() {
                return "g1";
            },
            get userId() {
                return "20001";
            },
            get isDirect() {
                return false;
            },
        };
        const source = (value: typeof accessorSession) =>
            value.channelId === "g1" && value.userId === "20001" && value.isDirect === false;
        expect(
            resolvePolicy(source as unknown as Computed<boolean>, accessorSession, isAssignPolicy),
        ).toEqual({ kind: "resolved", value: true });
    });

    it("函数读取 user 等延迟字段 → deferred", () => {
        const source = (value: typeof session & { user?: unknown }) => (value.user ? 0 : 1);
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数读取 event（可被 dispatch 期间改写）→ deferred", () => {
        const source = (value: typeof session & { event?: unknown }) => (value.event ? 0 : 1);
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数读取 elements 等可变引用 → deferred", () => {
        const source = (value: typeof session & { elements?: unknown }) => (value.elements ? 0 : 1);
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数自己 catch 延迟字段异常 → 仍判为 unsafe", () => {
        const source = (value: typeof session & { user?: unknown }) => {
            try {
                return value.user ? 0 : 1;
            } catch {
                return 1;
            }
        };
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数使用 in 操作符探测延迟字段 → deferred", () => {
        const source = (value: typeof session) => ("user" in value ? 0 : 1);
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数改写 session → deferred", () => {
        const source = (value: typeof session) => {
            (value as typeof session & { channelId: string }).channelId = "g2";
            return 1;
        };
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数抛错 → deferred", () => {
        const source = () => {
            throw new Error("boom");
        };
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("函数返回非法类型 → deferred", () => {
        const source = () => "3";
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
    });

    it("async 函数 → 不调用，直接 deferred", () => {
        let called = false;
        const source = async () => {
            called = true;
            return 1;
        };
        expect(
            resolvePolicy(source as unknown as Computed<number>, session, isAuthorizePolicy),
        ).toEqual({ kind: "deferred" });
        expect(called).toBe(false);
    });
});
