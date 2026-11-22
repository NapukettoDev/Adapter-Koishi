/**
 * applySessionFields 单测。
 *
 * 覆盖：必填字段直赋 / 可选字段条件展开（exactOptionalPropertyTypes：undefined 不 set）/
 * elements 特殊处理（只设 elements 不设 content，content 由 satorijs getter 派生）。
 * 用 Proxy 拦截 set 记录实际赋值 key，验证「不显式赋 undefined」语义。
 */
import { describe, expect, it } from "vitest";
import type { NapukettoSessionFields } from "../../events/index.js";
import { applySessionFields, type SessionLike } from "../dispatcher.js";

/** 拦截 session 赋值，记录被 set 的 key（验证条件展开语义）。 */
function trackAssignments(): { session: SessionLike; setKeys: string[] } {
    const setKeys: string[] = [];
    const target: SessionLike = {};
    const session = new Proxy<SessionLike>(target, {
        set(obj, prop, value) {
            if (typeof prop === "string") {
                setKeys.push(prop);
            }
            Reflect.set(obj, prop, value);
            return true;
        },
    });
    return { session, setKeys };
}

/** 全字段消息事件（必填 + 所有可选）。 */
const FULL_FIELDS: NapukettoSessionFields = {
    type: "message",
    subtype: "group",
    selfId: "10001",
    platform: "onebot",
    timestamp: 1_700_000_000_000,
    userId: "u1",
    operatorId: "u2",
    channelId: "g1",
    guildId: "g1",
    messageId: "m1",
    isDirect: false,
    elements: [{ type: "text", attrs: { content: "hi" } }],
};

describe("applySessionFields", () => {
    it("必填字段直接赋值", () => {
        const { session, setKeys } = trackAssignments();
        applySessionFields(session, {
            type: "message",
            selfId: "10001",
            platform: "onebot",
            timestamp: 1_700_000_000_000,
        });
        expect(session).toMatchObject({
            type: "message",
            selfId: "10001",
            platform: "onebot",
            timestamp: 1_700_000_000_000,
        });
        // 只有 4 个必填字段被 set，其余可选字段不 set
        expect(setKeys).toEqual(["type", "selfId", "platform", "timestamp"]);
    });

    it("可选字段有值 → 全部展开赋值", () => {
        const { session, setKeys } = trackAssignments();
        applySessionFields(session, FULL_FIELDS);
        expect(session).toMatchObject({
            subtype: "group",
            userId: "u1",
            operatorId: "u2",
            channelId: "g1",
            guildId: "g1",
            messageId: "m1",
            isDirect: false,
            elements: FULL_FIELDS.elements,
        });
        // 必填 4 + 可选 8
        expect(setKeys).toHaveLength(12);
        expect(setKeys).not.toContain("content");
    });

    it("可选字段缺省 → 不 set（条件展开；exactOptionalPropertyTypes 下对象字面量禁止显式 undefined）", () => {
        const { session, setKeys } = trackAssignments();
        applySessionFields(session, {
            type: "message",
            selfId: "1",
            platform: "onebot",
            timestamp: 0,
            userId: "u1", // 部分可选字段出现
        });
        // 只 set 出现过的可选字段 userId，其余（subtype/guildId/messageId/isDirect/elements）缺省不写
        expect(setKeys).toEqual(["type", "selfId", "platform", "timestamp", "userId"]);
        expect(session.subtype).toBeUndefined();
        expect(session.isDirect).toBeUndefined();
    });

    it("elements 特殊处理：只设 elements，不设 content", () => {
        const { session, setKeys } = trackAssignments();
        applySessionFields(session, FULL_FIELDS);
        // content 由 satorijs getter 派生——若直接赋会走 setter → h.parse 覆盖
        expect(setKeys).toContain("elements");
        expect(setKeys).not.toContain("content");
        expect(session.elements).toBe(FULL_FIELDS.elements);
    });

    it("isDirect 缺省 → 不设（避免显式 false 误导；不设则 satorijs 按 channel.type 判定）", () => {
        const { session, setKeys } = trackAssignments();
        applySessionFields(session, {
            type: "message",
            selfId: "1",
            platform: "onebot",
            timestamp: 0,
            userId: "u1",
        });
        expect(setKeys).toEqual(["type", "selfId", "platform", "timestamp", "userId"]);
        expect(session.isDirect).toBeUndefined();
    });
});
