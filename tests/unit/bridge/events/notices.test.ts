import {
    ElementType,
    GrayTipSubType,
    GroupNotifyMsgStatus,
    GroupNotifyMsgType,
    TipGroupElementType,
} from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { NapukettoInternal } from "../../../../src/bridge/actions/internal.js";
import { NapukettoEventBridge } from "../../../../src/bridge/events/bridge.js";
import type {
    NapukettoSessionFields,
    Ob11EventPayload,
} from "../../../../src/bridge/events/types.js";
import {
    encodeIpcMessage,
    IPC_VERSION,
    type IpcEventPayload,
} from "../../../../src/runtime/ipc/index.js";
import { createHarness, flush } from "../../../helpers/driver.js";
import { makeRawMessage, mockH } from "../../../helpers/events.js";

const TIME = 1_793_540_000;
const SELF = 10086;
const GROUP = 1101729931;
const MEMBER = 20001;
const ADMIN = 30001;
const RAW_MESSAGE_ID = "7509932998519874100";

function raw(service: string, name: string, ...args: unknown[]): IpcEventPayload {
    return { service, name, args };
}

function ob11(event: Ob11EventPayload): IpcEventPayload {
    return raw("ob11", event.post_type, event);
}

function fixtureNotice(noticeType: string, fields: Record<string, unknown>): Ob11EventPayload {
    return {
        post_type: "notice",
        notice_type: noticeType,
        time: TIME,
        self_id: SELF,
        user_id: MEMBER,
        ...fields,
    };
}

// Fixtures mirror the raw listeners and broadcasts in NapukettoQQ's OB11 adapter tests.
const groupRecall = fixtureNotice("group_recall", {
    group_id: GROUP,
    operator_id: ADMIN,
    message_id: 42,
});
const privateRecall = fixtureNotice("friend_recall", { user_id: SELF, message_id: 42 });
const memberAdded = fixtureNotice("group_increase", {
    group_id: GROUP,
    operator_id: ADMIN,
    sub_type: "invite",
});
const memberRemoved = fixtureNotice("group_decrease", {
    group_id: GROUP,
    operator_id: MEMBER,
    sub_type: "leave",
});
const friendRequest = {
    post_type: "request",
    request_type: "friend",
    self_id: SELF,
    user_id: MEMBER,
    comment: '你好 <at id="123"/>',
    flag: "1793540000001",
    time: TIME,
};
const groupRequest = {
    ...friendRequest,
    request_type: "group",
    sub_type: "add",
    group_id: GROUP,
    comment: "入群申请",
    flag: "90071992547409930",
};

const rawFriendRequest = raw("Buddy", "onBuddyReqChange", {
    unreadNums: 1,
    buddyReqs: [
        { friendUid: "u_member", reqTime: friendRequest.flag, extWords: friendRequest.comment },
    ],
});
const rawGroupRequest = raw("Group", "onGroupNotifiesUpdated", false, [
    {
        type: GroupNotifyMsgType.REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS,
        status: GroupNotifyMsgStatus.KUNHANDLE,
        seq: groupRequest.flag,
        group: { groupCode: String(GROUP), groupName: "测试群" },
        user1: { uid: "u_member", nickName: "新成员" },
        postscript: groupRequest.comment,
    },
]);

function rawRecall(direct: boolean) {
    return makeRawMessage({
        msgId: RAW_MESSAGE_ID,
        msgSeq: "42",
        msgTime: String(TIME),
        chatType: direct ? 1 : 2,
        peerUid: direct ? "u_member" : String(GROUP),
        peerUin: direct ? String(MEMBER) : String(GROUP),
        senderUin: String(direct ? SELF : MEMBER),
        senderUid: direct ? "u_self" : "u_member",
        elements: [
            {
                elementType: ElementType.GRAY_TIP,
                grayTipElement: {
                    subElementType: GrayTipSubType.REVOKE,
                    revokeElement: { operatorUid: direct ? "u_self" : String(ADMIN) },
                    groupElement: null,
                },
            },
        ],
    });
}

function rawMembership(type: 1 | 3): IpcEventPayload {
    return raw("Msg", "onRecvMsg", [
        makeRawMessage({
            chatType: 2,
            peerUid: String(GROUP),
            peerUin: String(GROUP),
            senderUin: String(MEMBER),
            elements: [
                {
                    elementType: ElementType.GRAY_TIP,
                    grayTipElement: {
                        subElementType: GrayTipSubType.GROUP,
                        groupElement: { type, memberUid: "u_member", adminUid: "u_admin" },
                        revokeElement: null,
                    },
                },
            ],
        }),
    ]);
}

function setup() {
    const dispatch = vi.fn<(fields: NapukettoSessionFields) => void>();
    const bridge = new NapukettoEventBridge({ dispatch, selfId: () => String(SELF), h: mockH() });
    const listener = vi.fn();
    const off = bridge.onOb11(listener);
    return { bridge, dispatch, listener, off };
}

describe("QQ 通知和请求", () => {
    it.each([
        { direct: false, notice: groupRecall, channelId: String(GROUP), operatorId: String(ADMIN) },
        {
            direct: true,
            notice: privateRecall,
            channelId: `private:${MEMBER}`,
            operatorId: String(SELF),
        },
    ])(
        "从 raw 还原撤回的原生 ID（direct=$direct），OB11 序号只传原始订阅",
        ({ direct, notice, channelId, operatorId }) => {
            const { bridge, dispatch, listener } = setup();
            const payload = raw("Msg", "onRecvMsg", [rawRecall(direct)]);
            bridge.handle(ob11(notice));
            bridge.handle(payload);
            bridge.handle(payload);
            bridge.handle(ob11(notice));
            expect(dispatch).toHaveBeenCalledExactlyOnceWith({
                type: "message-deleted",
                subtype: direct ? "private" : "group",
                timestamp: TIME * 1000,
                selfId: String(SELF),
                platform: "onebot",
                userId: String(direct ? SELF : MEMBER),
                operatorId,
                channelId,
                ...(direct ? {} : { guildId: String(GROUP) }),
                isDirect: direct,
                messageId: RAW_MESSAGE_ID,
            });
            expect(listener.mock.calls).toEqual([[notice], [notice]]);
        },
    );

    it("仅有 raw IPC 时仍派发撤回，保留可确认的字段", () => {
        const { bridge, dispatch } = setup();
        const recall = rawRecall(false);
        const tip = recall.elements[0]?.grayTipElement;
        if (!tip?.revokeElement) {
            throw new Error("撤回夹具缺少 grayTip");
        }
        tip.revokeElement.operatorUid = "u_unresolved_admin";
        bridge.handle(raw("Msg", "onRecvMsg", [{ ...recall, peerUin: "", msgId: "" }]));
        bridge.handle(raw("Msg", "onRecvMsg", [{ ...recall, senderUin: "0" }]));
        bridge.handle(raw("Msg", "onRecvMsg", [{ ...recall, peerUin: "", msgTime: "" }]));
        expect(dispatch).toHaveBeenCalledOnce();
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
            channelId: String(GROUP),
            messageId: RAW_MESSAGE_ID,
        });
        expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("operatorId");
    });

    it.each([
        [memberAdded, TipGroupElementType.MEMBER_ADD, "guild-member-added", ADMIN],
        [memberRemoved, TipGroupElementType.QUIT, "guild-member-removed", MEMBER],
    ] as const)(
        "群成员变动用 OB11 的成员与操作者 QQ 号",
        async (event, tipType, type, operator) => {
            const { bridge, dispatch, listener } = setup();
            bridge.handle(rawMembership(tipType));
            bridge.handle(ob11(event));
            bridge.handle(ob11({ ...event, operator_id: 0 }));
            await Promise.resolve();
            expect(dispatch).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    type,
                    userId: String(MEMBER),
                    operatorId: String(operator),
                    channelId: String(GROUP),
                    guildId: String(GROUP),
                    isDirect: false,
                    member: { user: { id: String(MEMBER) } },
                }),
            );
            expect(listener).toHaveBeenCalledTimes(2);
        },
    );

    it.each([
        [memberAdded, "guild-added", TipGroupElementType.MEMBER_ADD],
        [memberRemoved, "guild-removed", TipGroupElementType.QUIT],
    ] as const)("机器人进退群按 %s 对应的标准事件派发", (event, type, tipType) => {
        const { bridge, dispatch } = setup();
        bridge.handle(rawMembership(tipType));
        bridge.handle(ob11({ ...event, user_id: 0 }));
        bridge.handle(ob11({ ...event, group_id: 0 }));
        bridge.handle(ob11({ ...event, self_id: 99999 }));
        bridge.handle(ob11({ ...event, user_id: SELF, operator_id: 0 }));
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type, userId: String(SELF) }),
        );
        expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("operatorId");
    });

    it("群成员通知时间缺失时，短时间去重且允许后来再次加入", () => {
        const { bridge, dispatch } = setup();
        const dispatchClock = vi.spyOn(Date, "now").mockReturnValue(TIME * 1000);
        try {
            const event = ob11({ ...memberAdded, time: 0 });
            bridge.handle(event);
            bridge.handle(event);
            expect(dispatch).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ timestamp: TIME * 1000 }),
            );
            dispatchClock.mockReturnValue(TIME * 1000 + 10_000);
            bridge.handle(event);
            expect(dispatch).toHaveBeenCalledTimes(2);
        } finally {
            dispatchClock.mockRestore();
        }
    });

    it.each([
        {
            event: friendRequest,
            rawEvent: rawFriendRequest,
            type: "friend-request",
            action: "set_friend_add_request",
            note: "remark",
        },
        {
            event: groupRequest,
            rawEvent: rawGroupRequest,
            type: "guild-member-request",
            action: "set_group_add_request",
            note: "reason",
        },
    ])("$type 的 messageId 可直接交给审批动作", async ({ event, rawEvent, type, action, note }) => {
        const { bridge, dispatch, listener } = setup();
        bridge.handle(rawEvent);
        bridge.handle(ob11({ ...event, flag: "" }));
        bridge.handle(ob11({ ...event, user_id: 0 }));
        bridge.handle(ob11(event));
        bridge.handle(ob11({ ...event, time: TIME + 1 }));
        expect(dispatch).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledTimes(4);
        const session = dispatch.mock.calls[0]?.[0];
        const friend = type === "friend-request";
        expect(session).toMatchObject({
            type,
            userId: String(MEMBER),
            messageId: event.flag,
            isDirect: friend,
            channelId: friend ? `private:${MEMBER}` : String(GROUP),
            elements: [{ type: "text", attrs: { content: event.comment } }],
            ...(friend ? {} : { guildId: String(GROUP), member: { user: { id: String(MEMBER) } } }),
        });
        if (!session?.messageId) {
            throw new Error("请求 Session 缺少审批 ID");
        }
        const request = vi.fn(async () => ({ status: "ok", retcode: 0, data: null }));
        const internal = new NapukettoInternal({ request });
        if (friend) {
            await internal.handleFriendRequest(session.messageId, true, "已阅");
        } else {
            await internal.handleGuildMemberRequest(session.messageId, true, "已阅");
        }
        expect(request).toHaveBeenCalledExactlyOnceWith(action, {
            flag: event.flag,
            approve: true,
            [note]: "已阅",
        });
    });

    it("群邀请保留原始订阅，缺留言的好友和入群申请仍能派发", () => {
        const { bridge, dispatch, listener } = setup();
        bridge.handle(ob11({ ...groupRequest, sub_type: "invite" }));
        bridge.handle(ob11({ ...groupRequest, group_id: 0 }));
        bridge.handle(ob11({ ...groupRequest, flag: "undefined" }));
        bridge.handle(ob11({ ...groupRequest, comment: null }));
        bridge.handle(ob11({ ...friendRequest, comment: null }));
        expect(listener).toHaveBeenCalledTimes(5);
        expect(dispatch.mock.calls.map(([fields]) => fields.elements)).toEqual([[], []]);
        expect(dispatch.mock.calls.map(([fields]) => fields.type)).toEqual([
            "guild-member-request",
            "friend-request",
        ]);
    });

    it("戳一戳和表情回应各走原始入口，均不伪造标准表态", async () => {
        const { bridge, dispatch, listener } = setup();
        const poke = fixtureNotice("notify", {
            sub_type: "poke",
            target_id: SELF,
            group_id: GROUP,
        });
        bridge.handle(
            raw("Msg", "onRecvMsg", [
                makeRawMessage({
                    elements: [
                        {
                            elementType: ElementType.GRAY_TIP,
                            grayTipElement: { aioOpGrayTipElement: { peerUid: "u_self" } },
                        },
                    ],
                }),
            ]),
        );
        bridge.handle(ob11(poke));
        // NapukettoQQ Milky 732:16 fixture, with the actor field holding the bot placeholder.
        const bytes = Buffer.from(
            "0a06088ba1ac8d04120b08dc05101030a0ff9cd7061a21121fe2021c0a1a0a18080112030896011a0f0a023736280118012205755f626f74",
            "hex",
        );
        bridge.handle(raw("Msg", "onRecvSysMsg", [Uint8Array.from(bytes)]));
        expect(listener).toHaveBeenCalledExactlyOnceWith(poke);
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("驱动软重登保留标准去重和原始订阅，退订及停止后清理旧入口", async () => {
        const { bridge, dispatch, listener, off } = setup();
        const harness = createHarness({
            onEvent: (payload) => bridge.handle(payload),
            onEventSubscription: () => bridge.resetMessageBaseline(),
        });
        harness.driver.start();
        await flush();
        const host = harness.peers[0];
        const child = harness.spawns[0];
        if (host === undefined || child === undefined) {
            throw new Error("驱动未启动");
        }
        const write = (payload: IpcEventPayload) => {
            host.peer.write(encodeIpcMessage({ v: IPC_VERSION, type: "event", payload }));
        };
        const replay = [
            ob11(friendRequest),
            ob11(groupRequest),
            ob11(memberAdded),
            ob11(memberRemoved),
        ];
        try {
            harness.emit("ready");
            for (const payload of replay) {
                write(payload);
            }
            const recall = raw("Msg", "onRecvMsg", [
                { ...rawRecall(false), msgTime: String(Date.now()) },
            ]);
            write(recall);
            harness.emit("sessioning");
            harness.emit("ready");
            for (const payload of replay) {
                write(payload);
            }
            write(recall);
            expect(dispatch).toHaveBeenCalledTimes(5);
            expect(listener).toHaveBeenCalledTimes(8);
            off();
            write(ob11({ ...groupRequest, flag: "80000" }));
            expect(dispatch).toHaveBeenCalledTimes(6);
            expect(listener).toHaveBeenCalledTimes(8);
        } finally {
            const stopped = harness.driver.stop();
            child.emitExit(0, null);
            await stopped;
        }
        const remainingListener = vi.fn();
        const unsubscribe = bridge.onOb11(remainingListener);
        write(ob11({ ...groupRequest, flag: "70000" }));
        expect(dispatch).toHaveBeenCalledTimes(6);
        expect(remainingListener).not.toHaveBeenCalled();
        unsubscribe();
    });
});
