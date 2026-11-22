import { describe, expect, it, vi } from "vitest";
import { IPC_VERSION } from "../../src/runtime/ipc/index.js";
import { makeRawMessage } from "../helpers/events.js";
import { SELF_ID, setupPanel, startBot } from "./harness.js";

describe("Koishi 标准动作到子进程 IPC 的接线", () => {
    const groupId = "50001";
    const userId = "20001";
    const group = Number(groupId);
    const user = Number(userId);
    const member = {
        group_id: group,
        user_id: user,
        nickname: "昵称",
        card: "群名片",
        title: "头衔",
        role: "admin",
        join_time: 1_700_000_000,
    };
    const memberResult = {
        user: { id: userId, name: "昵称" },
        nick: "群名片",
        title: "头衔",
        roles: [{ id: "admin" }],
        joinedAt: 1_700_000_000_000,
    };

    async function startReadyBot() {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.ready();
        const respond = (action: string, data: unknown) => {
            child.actionResponses.set(action, { status: "ok", retcode: 0, data });
        };
        const expectAction = (action: string, params?: Record<string, unknown>) => {
            const last = child.received.at(-1);
            expect(last?.type === "action" ? last.payload : undefined).toEqual(
                params === undefined ? { action } : { action, params },
            );
        };
        return { bot, child, respond, expectAction };
    }

    it("读取用户资料或指定群内的用户，保留 QQ 号和昵称", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_stranger_info", { user_id: user, nickname: "QQ 昵称" });
        respond("get_group_member_info", member);

        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: "QQ 昵称" });
        expectAction("get_stranger_info", { user_id: user });
        await expect(bot.getUser(userId, groupId)).resolves.toEqual(memberResult.user);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        respond("get_stranger_info", { user_id: user, nickname: "" });
        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: userId });
    });

    it("读取成员及单页成员列表，过滤无法解析 QQ 号的成员", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_group_member_info", member);
        respond("get_group_member_list", [member, { ...member, user_id: Number.NaN }]);

        await expect(bot.getGuildMember(groupId, userId)).resolves.toEqual(memberResult);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [memberResult] });
        expectAction("get_group_member_list", { group_id: group });
        respond("get_group_member_list", []);
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [] });
    });

    it("群频道查询只返回指定群的文本频道，缺失时报告 NOT_FOUND", async () => {
        const { bot, child, expectAction } = await startReadyBot();
        child.actionResponses.set("group.getGroupList", [
            { groupCode: "50002", groupName: "其他群" },
            { groupCode: groupId, groupName: "目标群" },
        ]);

        await expect(bot.getChannelList(groupId)).resolves.toEqual({
            data: [{ id: groupId, name: "目标群", type: 0 }],
        });
        expectAction("group.getGroupList");
        await expect(bot.getChannelList("50003")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("只在永久踢人时设置拒绝再次入群", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_kick", null);

        await expect(bot.kickGuildMember(groupId, userId)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: false,
        });
        await expect(bot.kickGuildMember(groupId, userId, true)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: true,
        });
    });

    it.each([
        [30_000, 30],
        [1_001, 2],
        [1, 1],
        [0, 0],
    ])("禁言 %i 毫秒对应 %i 秒，零值解除禁言", async (duration, seconds) => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_ban", null);

        await expect(
            bot.muteGuildMember(groupId, userId, duration, "群管理说明"),
        ).resolves.toBeUndefined();
        expectAction("set_group_ban", { group_id: group, user_id: user, duration: seconds });
    });

    it("在发送 IPC 之前拒绝非法 QQ 号、分页令牌和时长", async () => {
        const { bot, child } = await startReadyBot();
        const sent = child.received.length;

        await expect(bot.getUser("9007199254740993")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.kickGuildMember("1e5", userId)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getGuildMemberList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getChannelList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        for (const duration of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(bot.muteGuildMember(groupId, userId, duration)).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        }
        expect(child.received).toHaveLength(sent);
    });

    it("拒绝 OB11 权限及资源失败、错误标识和异常响应", async () => {
        const { bot, child, respond } = await startReadyBot();
        child.actionResponses.set("set_group_kick", { status: "failed", retcode: 101, data: null });
        child.actionResponses.set("get_stranger_info", {
            status: "failed",
            retcode: 102,
            data: null,
        });

        await expect(bot.kickGuildMember(groupId, userId)).rejects.toMatchObject({ code: "101" });
        await expect(bot.getUser(userId)).rejects.toMatchObject({ code: "102" });
        respond("get_group_member_info", { ...member, user_id: user + 1 });
        await expect(bot.getGuildMember(groupId, userId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        respond("get_group_member_list", [{ ...member, group_id: group + 1 }]);
        await expect(bot.getGuildMemberList(groupId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        await expect(bot.muteGuildMember(groupId, userId, 5000)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });

    it.each([
        {
            event: { request_type: "friend", flag: "0000700" },
            type: "friend-request",
            method: "handleFriendRequest",
            action: "set_friend_add_request",
            params: { flag: "0000700", approve: true, remark: "审批说明" },
        },
        {
            event: {
                request_type: "group",
                sub_type: "add",
                group_id: group,
                flag: "90071992547409930",
            },
            type: "guild-member-request",
            method: "handleGuildMemberRequest",
            action: "set_group_add_request",
            params: { flag: "90071992547409930", approve: false, reason: "审批说明" },
        },
    ] as const)(
        "用 $type Session 的 messageId 调用标准审批方法",
        async ({ event, type, method, action, params }) => {
            const { bot, child, respond, expectAction } = await startReadyBot();
            respond(action, null);
            child.send({
                v: IPC_VERSION,
                type: "event",
                payload: {
                    service: "ob11",
                    name: "request",
                    args: [
                        { post_type: "request", self_id: Number(SELF_ID), user_id: user, ...event },
                    ],
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            const [session] = vi.mocked(bot.dispatch).mock.lastCall ?? [];
            expect(session).toMatchObject({ type, messageId: event.flag });
            if (session?.messageId === undefined) {
                throw new Error("Koishi 请求 Session 缺少 messageId");
            }
            await expect(
                bot[method](session.messageId, params.approve, "审批说明"),
            ).resolves.toBeUndefined();
            expectAction(action, params);
        },
    );

    it("Bot 的历史查询透传分页参数并返回旧消息", async () => {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.history = [
            makeRawMessage({ msgId: "newer", msgTime: "1700000002" }),
            makeRawMessage({ msgId: "older", msgTime: "1700000001" }),
            makeRawMessage({ msgId: "oldest", msgTime: "1700000000" }),
        ];
        child.ready();

        const page = await bot.getMessageList("10001", "anchor", "before", 2, "desc");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: {
                action: "msg.fetchMessages",
                params: { chatType: 2, peerUin: "10001", count: 4, msgId: "anchor" },
            },
        });
        expect(page.data).toMatchObject([
            { id: "newer", content: "你好", createdAt: 1_700_000_002_000 },
            { id: "older", content: "你好", createdAt: 1_700_000_001_000 },
        ]);
        expect(page.next).toBe("older");
        expect(bot.dispatch).not.toHaveBeenCalled();
    });
});
