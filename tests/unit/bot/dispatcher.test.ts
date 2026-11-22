/**
 * dispatcher 单测。
 *
 * 覆盖：静态 autoAssign/autoAuthorize 预热 / 动态 Computed 跳过对应预热（交还
 * Koishi 按真实 session 求值）/ 空 selfId 不写 channel / 预热失败不阻断派发 /
 * 预热期间 client 被替换时停止派发；以及 applySessionFields 的条件赋值语义。
 *
 * 用 Proxy 拦截 set 记录实际赋值 key，验证「不显式赋 undefined」语义。
 */
import type { Bot, Computed } from "koishi";
import { describe, expect, it, vi } from "vitest";
import {
    applySessionFields,
    SessionDispatcher,
    type SessionLike,
} from "../../../src/bot/dispatcher.js";
import type { NapukettoSessionFields } from "../../../src/bridge/events/types.js";
import type { NapukettoIpcClient } from "../../../src/runtime/ipc/index.js";

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

describe("SessionDispatcher", () => {
    function makeDispatcher(
        options: {
            autoAssign?: Computed<boolean>;
            autoAuthorize?: Computed<number>;
            getClient?: () => NapukettoIpcClient | null;
        } = {},
    ) {
        const dispatch = vi.fn();
        const warn = vi.fn();
        const ensureChannel = vi.fn(async () => {});
        const ensureUser = vi.fn(async () => {});
        const client = {} as NapukettoIpcClient;
        const dispatcher = new SessionDispatcher({
            bot: {
                session: vi.fn(() => ({})) as unknown as Bot["session"],
                dispatch,
            },
            logger: { info: vi.fn(), warn },
            database: { ensureChannel, ensureUser },
            autoAssign: options.autoAssign ?? true,
            autoAuthorize: options.autoAuthorize ?? 1,
            getClient: options.getClient ?? (() => client),
        });
        return { dispatcher, dispatch, warn, ensureChannel, ensureUser, client };
    }

    const fields: NapukettoSessionFields = {
        type: "message",
        subtype: "group",
        selfId: "10001",
        platform: "onebot",
        timestamp: 1_700_000_000_000,
        userId: "20001",
        channelId: "10001",
        guildId: "10001",
        messageId: "m1",
        isDirect: false,
        elements: [{ type: "text", attrs: { content: "hi" } }],
    };

    it("预热失败只 warn，不阻断 session 派发", async () => {
        const { dispatcher, dispatch, warn, ensureUser } = makeDispatcher();
        const failure = new Error("数据库暂时不可写");
        ensureUser.mockRejectedValueOnce(failure);
        await expect(dispatcher.dispatch(fields)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith("[napuketto] 会话预热失败（继续派发）: %o", failure);
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("静态 autoAssign=true / autoAuthorize=1 → 预热 channel 与 user", async () => {
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher();
        await dispatcher.dispatch(fields);
        expect(ensureChannel).toHaveBeenCalledWith({
            platform: "onebot",
            id: "10001",
            guildId: "10001",
            assignee: "10001",
        });
        expect(ensureUser).toHaveBeenCalledWith({
            platform: "onebot",
            userId: "20001",
            authority: 1,
        });
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("静态 autoAssign=false → 跳过 channel 预热，user 仍预热", async () => {
        const { dispatcher, ensureChannel, ensureUser } = makeDispatcher({ autoAssign: false });
        await dispatcher.dispatch(fields);
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(ensureUser).toHaveBeenCalledWith({
            platform: "onebot",
            userId: "20001",
            authority: 1,
        });
    });

    it("静态 autoAuthorize=0 → 不预热 user（detached）", async () => {
        const { dispatcher, ensureChannel, ensureUser } = makeDispatcher({ autoAuthorize: 0 });
        await dispatcher.dispatch(fields);
        expect(ensureChannel).toHaveBeenCalledOnce();
        expect(ensureUser).not.toHaveBeenCalled();
    });

    it("动态 autoAssign（函数返回 false）→ 函数按真实 session 求值，跳过 channel 预热", async () => {
        let seen: Record<string, unknown> | undefined;
        const autoAssign = vi.fn((session: SessionLike) => {
            seen = {
                selfId: session.selfId,
                channelId: session.channelId,
                userId: session.userId,
            };
            return false;
        });
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher({ autoAssign });
        await dispatcher.dispatch(fields);
        expect(autoAssign).toHaveBeenCalledOnce();
        expect(seen).toEqual({
            selfId: "10001",
            channelId: "10001",
            userId: "20001",
        });
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(ensureUser).toHaveBeenCalledOnce();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("动态 autoAssign（安全读取 session 字段）→ 按求值结果预热 channel", async () => {
        const autoAssign = vi.fn((session: SessionLike) => session.channelId === "10001");
        const { dispatcher, ensureChannel } = makeDispatcher({ autoAssign });
        await dispatcher.dispatch(fields);
        expect(ensureChannel).toHaveBeenCalledWith({
            platform: "onebot",
            id: "10001",
            guildId: "10001",
            assignee: "10001",
        });
    });

    it("动态 autoAuthorize（函数返回 0）→ 函数按真实 session 求值，不预热 user", async () => {
        const autoAuthorize = vi.fn((_session: SessionLike) => 0);
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher({
            autoAuthorize,
        });
        await dispatcher.dispatch(fields);
        expect(autoAuthorize).toHaveBeenCalledOnce();
        expect(ensureChannel).toHaveBeenCalledOnce();
        expect(ensureUser).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("动态 autoAuthorize（安全读取 session 字段）→ 按求值结果预热 user", async () => {
        const autoAuthorize = vi.fn((session: SessionLike) => (session.isDirect === true ? 0 : 3));
        const { dispatcher, ensureUser } = makeDispatcher({ autoAuthorize });
        await dispatcher.dispatch(fields);
        expect(ensureUser).toHaveBeenCalledWith({
            platform: "onebot",
            userId: "20001",
            authority: 3,
        });
    });

    it("动态函数读取 user 等延迟字段 → 放弃预热，不写错误 assignment", async () => {
        const autoAuthorize = vi.fn((session: SessionLike) => {
            const withUser = session as SessionLike & { user?: unknown };
            return withUser.user ? 0 : 1;
        });
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher({
            autoAuthorize,
        });
        await dispatcher.dispatch(fields);
        expect(autoAuthorize).toHaveBeenCalledOnce();
        expect(ensureChannel).toHaveBeenCalledOnce();
        expect(ensureUser).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("动态函数抛错或返回非法类型 → 放弃对应预热，仍派发", async () => {
        const assign = vi.fn(() => {
            throw new Error("boom");
        });
        const authorize = vi.fn(() => "3" as unknown as number);
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher({
            autoAssign: assign,
            autoAuthorize: authorize,
        });
        await dispatcher.dispatch(fields);
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(ensureUser).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("动态 async 函数 → 不符合同步 Computed 契约，不调用", async () => {
        let called = false;
        const autoAssign = async () => {
            called = true;
            return true;
        };
        const { dispatcher, dispatch, ensureChannel } = makeDispatcher({
            autoAssign: autoAssign as unknown as Computed<boolean>,
        });
        await dispatcher.dispatch(fields);
        expect(called).toBe(false);
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("动态 autoAuthorize（Eval 表达式）→ 跳过 user 预热", async () => {
        // biome-ignore lint/style/useNamingConvention: minato Eval 表达式使用 `$` 键
        const autoAuthorize = { $: "session.channelId" } as unknown as Computed<number>;
        const { dispatcher, dispatch, ensureChannel, ensureUser } = makeDispatcher({
            autoAuthorize,
        });
        await dispatcher.dispatch(fields);
        expect(ensureChannel).toHaveBeenCalledOnce();
        expect(ensureUser).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledOnce();
    });

    it("selfId 为空 → 不预热 channel（koishi 走 detached，不落库）", async () => {
        const { dispatcher, ensureChannel, ensureUser } = makeDispatcher();
        await dispatcher.dispatch({ ...fields, selfId: "" });
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(ensureUser).toHaveBeenCalledOnce();
    });

    it("非 message 事件 → 不预热", async () => {
        const { dispatcher, ensureChannel, ensureUser } = makeDispatcher();
        await dispatcher.dispatch({ ...fields, type: "notice" });
        expect(ensureChannel).not.toHaveBeenCalled();
        expect(ensureUser).not.toHaveBeenCalled();
    });

    it("预热期间 client 被替换 → 不派发", async () => {
        const client = {} as NapukettoIpcClient;
        const getClient = vi
            .fn<() => NapukettoIpcClient | null>()
            .mockReturnValueOnce(client)
            .mockReturnValueOnce(null);
        const { dispatcher, dispatch } = makeDispatcher({ getClient });
        await dispatcher.dispatch(fields);
        expect(dispatch).not.toHaveBeenCalled();
    });
});

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
