/**
 * transform.test.ts：kernel → koishi Universal 形状翻译纯函数单测。
 *
 * transform.ts 仅 import type koishi + 共享常量（无 koishi 运行时）→ 可单测
 * （规避方式见 docs/guides/development.md 单测边界）。覆盖：好友/群/频道/登录信息映射 + 空值兜底。
 */
import { describe, expect, it } from "vitest";
import {
    resolveBotLogin,
    toDirectChannel,
    toFriendList,
    toGuildList,
    toTextChannel,
    toUserFields,
} from "../../../src/bot/transform.js";

describe("toFriendList", () => {
    it("undefined → 空列表", () => {
        expect(toFriendList(undefined)).toEqual({ data: [] });
    });

    it("空数组 → 空列表", () => {
        expect(toFriendList([])).toEqual({ data: [] });
    });

    it("正常数据映射 uin/nickname", () => {
        expect(toFriendList([{ uin: "10001", nickname: "小明" }])).toEqual({
            data: [
                {
                    user: { id: "10001", name: "小明" },
                    nick: "小明",
                },
            ],
        });
    });

    it("好友备注优先，非数组及缺 UIN 条目保留空列表语义", () => {
        expect(toFriendList({ data: [] })).toEqual({ data: [] });
        expect(
            toFriendList([
                null,
                { uid: "u_unknown", uin: null, nickname: "未知 UIN" },
                { uid: "u_bad", uin: " ", nickname: "空 UIN" },
                { uid: "u_friend", uin: "34567", nickname: "昵称", remark: "备注" },
            ]),
        ).toEqual({ data: [{ user: { id: "34567", name: "昵称" }, nick: "备注" }] });
    });

    it("缺 nickname → 用 uin 兜底", () => {
        expect(toFriendList([{ uin: "10002" }])).toEqual({
            data: [
                {
                    user: { id: "10002", name: "10002" },
                    nick: "10002",
                },
            ],
        });
    });
});

describe("toGuildList", () => {
    it("undefined → 空列表", () => {
        expect(toGuildList(undefined)).toEqual({ data: [] });
    });

    it("正常数据映射 groupCode/groupName", () => {
        expect(toGuildList([{ groupCode: "888", groupName: "测试群" }])).toEqual({
            data: [{ id: "888", name: "测试群" }],
        });
    });

    it("过滤无身份群条目，非数组时返回空列表", () => {
        expect(toGuildList("bad")).toEqual({ data: [] });
        expect(toGuildList([null, { groupCode: "" }, { groupCode: "888" }])).toEqual({
            data: [{ id: "888", name: "888" }],
        });
    });

    it("缺 groupName → 用 groupCode 兜底", () => {
        expect(toGuildList([{ groupCode: "999" }])).toEqual({
            data: [{ id: "999", name: "999" }],
        });
    });
});

describe("toDirectChannel", () => {
    it("生成 private:<uin> DIRECT 频道", () => {
        expect(toDirectChannel("10001")).toEqual({
            id: "private:10001",
            type: 1,
            name: "10001",
        });
    });
});

describe("toTextChannel", () => {
    it("有 guildName 用群名", () => {
        expect(toTextChannel("888", "测试群")).toEqual({
            id: "888",
            type: 0,
            name: "测试群",
        });
    });

    it("无 guildName 用 channelId 兜底", () => {
        expect(toTextChannel("888")).toEqual({ id: "888", type: 0, name: "888" });
    });
});

describe("toUserFields", () => {
    it("正常 uin/nick → id/name 字段", () => {
        expect(toUserFields({ uin: "10001", nick: "小明" })).toEqual({
            id: "10001",
            name: "小明",
        });
    });

    it("空串 uin/nick → 不产出字段（保留既有值语义）", () => {
        expect(toUserFields({ uin: "", nick: "" })).toEqual({});
    });

    it("undefined 字段 → 不产出字段", () => {
        expect(toUserFields({})).toEqual({});
    });
});

describe("resolveBotLogin", () => {
    type LoginBot = Parameters<typeof resolveBotLogin>[0];

    function makeBot(getSelf: () => Promise<unknown>) {
        return {
            selfId: "10001",
            user: {},
            toJSON: () => ({ selfId: "10001" }),
            internal: { getSelf },
        } as unknown as LoginBot & { selfId: string; user: Record<string, unknown> };
    }

    it("缺快照时拉取 getSelf，仍绑定配置账号", async () => {
        const bot = makeBot(async () => ({ uin: "10001", nickname: "测试号" }));
        await resolveBotLogin(bot, undefined);
        expect(bot.selfId).toBe("10001");
        expect(bot.user).toMatchObject({ id: "10001", name: "测试号" });
    });

    it("异步查询返回时已换轮 → 丢弃结果，不写回旧账号", async () => {
        const bot = makeBot(async () => ({ uin: "10001", nickname: "旧账号" }));
        await resolveBotLogin(bot, undefined, () => false);
        expect(bot.selfId).toBe("10001");
        expect(bot.user).toEqual({});
    });

    it("查询结果不是配置账号 → 不写回身份", async () => {
        const bot = makeBot(async () => ({ uin: "20002", nickname: "错误账号" }));
        await resolveBotLogin(bot, undefined);
        expect(bot.user).toEqual({});
    });

    it("快照身份在换轮后也不写回", async () => {
        const bot = makeBot(async () => ({ uin: "10001" }));
        await resolveBotLogin(bot, { uin: "10001", uid: "u1", nick: "旧快照" }, () => false);
        expect(bot.selfId).toBe("10001");
        expect(bot.user).toEqual({});
    });
});
