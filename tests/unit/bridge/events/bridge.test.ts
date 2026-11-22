/**
 * bridge.test.ts：事件桥单测（kernel 事件 → dispatch）。
 */
import { describe, expect, it, vi } from "vitest";
import { NapukettoEventBridge } from "../../../../src/bridge/events/bridge.js";
import type { IpcEventPayload } from "../../../../src/runtime/ipc/index.js";
import { mockH } from "../../../helpers/events.js";

/** 构造 Msg/onRecvMsg 事件 payload（消息数组或单条——bridge 兼容两者）。 */
function recvPayload(messages: unknown): IpcEventPayload {
    return { service: "Msg", name: "onRecvMsg", args: [messages] };
}

describe("NapukettoEventBridge", () => {
    it("Msg/onRecvMsg（数组）→ 逐条 dispatch", async () => {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({
            dispatch,
            selfId: () => "10086",
            platform: "onebot",
            h: mockH(),
        });
        bridge.handle(
            recvPayload([
                {
                    msgId: "m1",
                    msgSeq: "1",
                    msgTime: "1700000000",
                    msgType: 9,
                    chatType: 2,
                    peerUid: "u_peer",
                    peerUin: "10001",
                    senderUid: "u_s",
                    senderUin: "20001",
                    peerName: "群",
                    sendNickName: "小明",
                    elements: [{ elementType: 1, textElement: { content: "a" } }],
                },
                {
                    msgId: "m2",
                    msgSeq: "2",
                    msgTime: "1700000001",
                    msgType: 9,
                    chatType: 1,
                    peerUid: "u_s",
                    peerUin: "20001",
                    senderUid: "u_s",
                    senderUin: "20001",
                    peerName: "小明",
                    sendNickName: "小明",
                    elements: [{ elementType: 1, textElement: { content: "b" } }],
                },
            ]),
        );
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
            type: "message",
            subtype: "group",
            userId: "20001",
            channelId: "10001",
        });
        expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
            type: "message",
            subtype: "private",
            channelId: "private:20001",
        });
    });

    it("Msg/onRecvMsg 单条（非数组）兼容", async () => {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({
            dispatch,
            selfId: () => "10086",
            h: mockH(),
        });
        bridge.handle(
            recvPayload({
                msgId: "m1",
                msgSeq: "1",
                msgTime: "1700000000",
                msgType: 9,
                chatType: 2,
                peerUid: "u_peer",
                peerUin: "10001",
                senderUid: "u_s",
                senderUin: "20001",
                peerName: "群",
                sendNickName: "小明",
                elements: [{ elementType: 1, textElement: { content: "x" } }],
            }),
        );
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    });

    it("非 Msg/onRecvMsg 事件忽略", () => {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({ dispatch, selfId: () => "1", h: mockH() });
        bridge.handle({ service: "Group", name: "onGroupListUpdate", args: [] });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("数组含无效项跳过", async () => {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({ dispatch, selfId: () => "1", h: mockH() });
        const raw: Record<string, unknown> = {
            msgId: "ok",
            msgSeq: "1",
            msgTime: "0",
            msgType: 9,
            chatType: 2,
            peerUid: "u",
            peerUin: "1",
            senderUid: "u",
            senderUin: "2",
            peerName: "",
            sendNickName: "",
            elements: [],
        };
        bridge.handle(recvPayload([null, "string", raw]));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    });

    it("系统占位消息（senderUin=0）跳过，不 dispatch", async () => {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({ dispatch, selfId: () => "1", h: mockH() });
        const system: Record<string, unknown> = {
            msgId: "sys1",
            msgSeq: "0",
            msgTime: "0",
            msgType: 9,
            chatType: 2,
            peerUid: "u",
            peerUin: "10001",
            senderUid: "u",
            senderUin: "0",
            peerName: "",
            sendNickName: "",
            elements: [],
        };
        // 批量里混着 2 条系统消息 + 1 条真实消息 → 只 dispatch 真实消息
        bridge.handle(
            recvPayload([
                system,
                { ...system, msgId: "sys2" },
                { ...system, msgId: "real", senderUin: "20001" },
            ]),
        );
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
            type: "message",
            userId: "20001",
            channelId: "10001",
        });
    });
});

describe("NapukettoEventBridge 异常隔离", () => {
    function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            msgId: "m1",
            msgSeq: "1",
            msgTime: "1700000000",
            msgType: 9,
            chatType: 2,
            peerUid: "u_peer",
            peerUin: "10001",
            senderUid: "u_s",
            senderUin: "20001",
            peerName: "群",
            sendNickName: "小明",
            elements: [{ elementType: 1, textElement: { content: "a" } }],
            ...overrides,
        };
    }

    function makeBridge() {
        const dispatch = vi.fn();
        const onError = vi.fn();
        const bridge = new NapukettoEventBridge({
            dispatch,
            selfId: () => "1",
            h: mockH(),
            onError,
        });
        return { bridge, dispatch, onError };
    }

    it("坏事件被丢弃并诊断，同批后续有效事件继续送达", async () => {
        const { bridge, dispatch, onError } = makeBridge();
        bridge.handle(recvPayload([makeRaw({ msgId: "bad", elements: "x" }), makeRaw()]));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "elements 不是数组" }),
            "消息事件结构非法（已丢弃）",
        );
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ messageId: "m1" });
    });

    it("元素转换抛错只丢弃该条事件，后续有效事件继续送达", async () => {
        const { bridge, dispatch, onError } = makeBridge();
        const broken = makeRaw({
            msgId: "broken",
            elements: [
                {
                    elementType: 1,
                    get textElement(): never {
                        throw new Error("元素读取爆炸");
                    },
                },
            ],
        });
        bridge.handle(recvPayload([broken, makeRaw({ msgId: "after" })]));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ messageId: "after" });
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "元素读取爆炸" }),
            "消息事件转换失败（已丢弃）",
        );
    });

    it("会话派发异步拒绝 → 诊断且后续事件继续派发", async () => {
        const dispatch = vi
            .fn()
            .mockRejectedValueOnce(new Error("派发异步失败"))
            .mockResolvedValue(undefined);
        const onError = vi.fn();
        const bridge = new NapukettoEventBridge({
            dispatch,
            selfId: () => "1",
            h: mockH(),
            onError,
        });
        bridge.handle(recvPayload(makeRaw({ msgId: "first" })));
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: "派发异步失败" }),
                "会话派发失败（异步）",
            ),
        );
        bridge.handle(recvPayload(makeRaw({ msgId: "second" })));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    });

    it("会话派发同步抛错 → 诊断且后续事件继续派发", async () => {
        const dispatch = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error("派发同步失败");
            })
            .mockResolvedValue(undefined);
        const onError = vi.fn();
        const bridge = new NapukettoEventBridge({
            dispatch,
            selfId: () => "1",
            h: mockH(),
            onError,
        });
        bridge.handle(recvPayload(makeRaw({ msgId: "first" })));
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: "派发同步失败" }),
                "会话派发失败（同步）",
            ),
        );
        bridge.handle(recvPayload(makeRaw({ msgId: "second" })));
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    });

    it("OB11 单订阅者异常被诊断并隔离，后续订阅者与事件继续", () => {
        const { bridge, onError } = makeBridge();
        const first = vi.fn(() => {
            throw new Error("订阅者 A 失败");
        });
        const second = vi.fn();
        bridge.onOb11(first);
        bridge.onOb11(second);
        bridge.handle({ service: "ob11", name: "notice", args: [{ post_type: "notice" }] });
        expect(second).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "订阅者 A 失败" }),
            "OB11 订阅者异常（已隔离）",
        );

        second.mockClear();
        bridge.handle({ service: "ob11", name: "notice", args: [{ post_type: "notice" }] });
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("OB11 结构非法 → 诊断且不影响后续合法事件", () => {
        const { bridge, onError } = makeBridge();
        const listener = vi.fn();
        bridge.onOb11(listener);
        bridge.handle({ service: "ob11", name: "unknown", args: [{ foo: 1 }] });
        expect(listener).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "缺少 post_type 或不是对象" }),
            "OB11 事件结构非法（已丢弃）",
        );
        bridge.handle({ service: "ob11", name: "message", args: [{ post_type: "message" }] });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe("NapukettoEventBridge（OB11 原始事件，docs/internals/actions.md）", () => {
    function makeBridge() {
        const dispatch = vi.fn();
        const bridge = new NapukettoEventBridge({ dispatch, selfId: () => "1", h: mockH() });
        return { bridge, dispatch };
    }

    it("service=ob11 → args[0] 完整事件分发到订阅者（不经 session dispatch）", () => {
        const { bridge, dispatch } = makeBridge();
        const listener = vi.fn();
        bridge.onOb11(listener);
        bridge.handle({
            service: "ob11",
            name: "notice",
            args: [{ post_type: "notice", notice_type: "notify", sub_type: "poke" }],
        });
        expect(listener).toHaveBeenCalledWith({
            post_type: "notice",
            notice_type: "notify",
            sub_type: "poke",
        });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("退订后不再收到；单订阅者异常不中断其他订阅者", () => {
        const { bridge } = makeBridge();
        const a = vi.fn(() => {
            throw new Error("订阅者异常");
        });
        const b = vi.fn();
        const off = bridge.onOb11(a);
        bridge.onOb11(b);
        bridge.handle({ service: "ob11", name: "message", args: [{ post_type: "message" }] });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        off();
        bridge.handle({ service: "ob11", name: "message", args: [{ post_type: "message" }] });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(2);
    });

    it("事件结构异常（缺 post_type / 非对象）丢弃", () => {
        const { bridge } = makeBridge();
        const listener = vi.fn();
        bridge.onOb11(listener);
        bridge.handle({ service: "ob11", name: "unknown", args: [{ foo: 1 }] });
        bridge.handle({ service: "ob11", name: "unknown", args: ["string"] });
        bridge.handle({ service: "ob11", name: "unknown", args: [] });
        expect(listener).not.toHaveBeenCalled();
    });
});
