/**
 * internal.test.ts：NapukettoInternal 单测（mock request 注入，docs/internals/actions.md）。
 *
 * 语音用例（2026-08-23）：sendMessage 里 audio → voice 后统一转 silk
 * （mock @napuketto/media，真实文件头判断在 media.test.ts 覆盖）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElementType } from "@napuketto/kernel";
import { h } from "@satorijs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRawMessage } from "../../events/test-utils.js";
import { NapukettoInternal } from "../internal.js";
import type { RequestFn } from "../types.js";

const { encodePcmToSilkMock } = vi.hoisted(() => ({ encodePcmToSilkMock: vi.fn() }));
vi.mock("@napuketto/media", () => ({ encodePcmToSilk: encodePcmToSilkMock }));

/** 构造 internal + mock request（记录调用，可自定义返回）。 */
function createInternal(
    impl?: (action: string, params?: Record<string, unknown>) => Promise<unknown>,
): {
    internal: NapukettoInternal;
    request: ReturnType<typeof vi.fn<RequestFn>>;
} {
    const request = vi.fn<RequestFn>(impl ?? (async () => ({})));
    const internal = new NapukettoInternal({ request, h });
    return { internal, request };
}

/** koishi audio 元素宽松结构（toCanonicalElements 消费）。 */
function audioElement(src: string): { type: string; attrs: { src: string }; toString(): string } {
    return { type: "audio", attrs: { src }, toString: () => "[audio]" };
}

describe("NapukettoInternal", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "napuketto-koishi-internal-"));
        encodePcmToSilkMock.mockReset();
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("sendMessage：群聊 → msg.sendMessage（元素反向映射）", async () => {
        const { internal, request } = createInternal(async () => ({ msgId: "m1" }));
        const ids = await internal.sendMessage("123456789", "你好");
        expect(ids).toEqual(["m1"]);
        expect(request).toHaveBeenCalledWith("msg.sendMessage", {
            chatType: 2,
            peerUin: "123456789",
            elements: [{ type: "text", text: "你好" }],
        });
    });

    it("sendMessage：语音（audio）→ 转 silk 后发（非 silk 原路径不直发）", async () => {
        const { internal, request } = createInternal(async () => ({ msgId: "m3" }));
        const ogg = join(dir, "voice.ogg");
        writeFileSync(ogg, Buffer.from("OggS........"));
        const silk = join(dir, "voice.silk");
        encodePcmToSilkMock.mockResolvedValue(silk);

        const ids = await internal.sendMessage("123456789", [audioElement(ogg)]);

        expect(ids).toEqual(["m3"]);
        expect(request).toHaveBeenCalledWith("msg.sendMessage", {
            chatType: 2,
            peerUin: "123456789",
            elements: [{ type: "voice", path: silk }],
        });
    });

    it("sendMessage：私聊 → chatType=1", async () => {
        const { internal, request } = createInternal(async () => ({ msgId: "m2" }));
        await internal.sendMessage("private:10001", "在吗");
        expect(request).toHaveBeenCalledWith("msg.sendMessage", {
            chatType: 1,
            peerUin: "10001",
            elements: [{ type: "text", text: "在吗" }],
        });
    });

    it("消息动作使用登录 UID 寻址自聊", async () => {
        const request = vi.fn<RequestFn>(async () => ({ msgId: "self-message" }));
        const internal = new NapukettoInternal({
            request,
            h,
            getSelfIdentity: () => ({ uin: "10001", uid: "u_self" }),
        });
        const channel = "private:10001";
        await expect(internal.sendMessage(channel, "发给自己")).resolves.toEqual(["self-message"]);
        await internal.getMessageList(channel);
        await internal.markAsRead(channel);
        await internal.deleteMessage(channel, "self-message");

        expect(request.mock.calls.map(([action, params]) => [action, params?.["peerUid"]])).toEqual(
            [
                ["msg.sendMessage", "u_self"],
                ["msg.fetchMessages", "u_self"],
                ["msg.markRead", "u_self"],
                ["msg.recallMessage", "u_self"],
            ],
        );
    });

    it("sendMessage：空内容 → 不请求返回 []", async () => {
        const { internal, request } = createInternal();
        const ids = await internal.sendMessage("123", "");
        expect(ids).toEqual([]);
        expect(request).not.toHaveBeenCalled();
    });

    it("sendMessage：result 无 msgId → 返回 []", async () => {
        const { internal } = createInternal(async () => ({}));
        const ids = await internal.sendMessage("123", "hi");
        expect(ids).toEqual([]);
    });

    it("deleteMessage → msg.recallMessage", async () => {
        const { internal, request } = createInternal();
        await internal.deleteMessage("123", "mid-1");
        expect(request).toHaveBeenCalledWith("msg.recallMessage", {
            chatType: 2,
            peerUin: "123",
            msgIds: ["mid-1"],
        });
    });

    it("markAsRead → msg.markRead", async () => {
        const { internal, request } = createInternal();
        await internal.markAsRead("123");
        expect(request).toHaveBeenCalledWith("msg.markRead", {
            chatType: 2,
            peerUin: "123",
        });
    });

    it("getGroupList / getFriendList / getSelf 透传", async () => {
        const { internal, request } = createInternal(async () => []);
        await internal.getGroupList();
        await internal.getFriendList();
        await internal.getSelf();
        expect(request).toHaveBeenNthCalledWith(1, "group.getGroupList");
        expect(request).toHaveBeenNthCalledWith(2, "friend.getFriendList");
        expect(request).toHaveBeenNthCalledWith(3, "login.getSelf");
    });

    it("_request 透传（传输抽象）", async () => {
        const { internal, request } = createInternal(async () => ({ ok: 1 }));
        const value = await internal._request("msg.sendMessage", { chatType: 2 });
        expect(value).toEqual({ ok: 1 });
        expect(request).toHaveBeenCalledWith("msg.sendMessage", { chatType: 2 });
    });
});

describe("getMessageList", () => {
    it("将群聊历史转为 Koishi 消息，保留原始 ID、文本、引用和毫秒精度", async () => {
        const raw = makeRawMessage({
            msgId: "7483933495418198130",
            msgTime: "1700000000123",
            elements: [
                { elementType: ElementType.REPLY, replyElement: { replayMsgId: "original" } },
                { elementType: ElementType.TEXT, textElement: { content: "你好" } },
            ],
        });
        const { internal, request } = createInternal(async () => [raw]);
        const result = await internal.getMessageList("10001");
        expect(request).toHaveBeenCalledWith("msg.fetchMessages", {
            chatType: 2,
            peerUin: "10001",
            count: 21,
        });
        expect(result).toEqual({
            data: [
                {
                    id: "7483933495418198130",
                    user: { id: "20001", name: "小明" },
                    channel: { id: "10001", type: 0 },
                    guild: { id: "10001" },
                    elements: [h("quote", { id: "original" }), h.text("你好")],
                    content: '<quote id="original"/>你好',
                    quote: { id: "original" },
                    timestamp: 1_700_000_000_123,
                    createdAt: 1_700_000_000_123,
                },
            ],
        });
    });

    it("私聊频道固定为查询对端，发送者取自各条记录，非法时间省略", async () => {
        const received = makeRawMessage({
            chatType: 1,
            msgId: "received",
            msgTime: "0",
            sendNickName: "",
            sendMemberName: "对方",
        });
        const sent = makeRawMessage({
            chatType: 1,
            msgId: "sent",
            msgTime: "1600000000",
            senderUin: "10086",
            sendNickName: "本人",
        });
        const { internal, request } = createInternal(async () => [received, sent, { msgId: "" }]);
        const { data } = await internal.getMessageList("private:20001");
        expect(request).toHaveBeenCalledWith("msg.fetchMessages", {
            chatType: 1,
            peerUin: "20001",
            count: 21,
        });
        expect(data).toMatchObject([
            {
                id: "sent",
                user: { id: "10086", name: "本人" },
                channel: { id: "private:20001", type: 1 },
                timestamp: 1_600_000_000_000,
            },
            {
                id: "received",
                user: { id: "20001", name: "对方" },
                channel: { id: "private:20001" },
            },
        ]);
        expect(data[1]).not.toHaveProperty("timestamp");
        expect(data[1]).not.toHaveProperty("createdAt");
        expect(data[0]).not.toHaveProperty("guild");
    });

    it.each([true, false])(
        "翻页不重复锚点且顺序不影响游标（服务端含锚点=%s）",
        async (inclusive) => {
            const history = ["newest", "newer", "older", "oldest"].map((msgId) =>
                makeRawMessage({ msgId }),
            );
            const { internal, request } = createInternal(async (_action, params) => {
                const anchor = params?.["msgId"];
                const index = history.findIndex((message) => message.msgId === anchor);
                const start = index < 0 ? 0 : index + (inclusive ? 0 : 1);
                return history.slice(start, start + Number(params?.["count"]));
            });

            const first = await internal.getMessageList("123", undefined, 2);
            expect(first.data.map((message) => message.id)).toEqual(["newer", "newest"]);
            expect(first).toMatchObject({ next: "newer", prev: "newer" });
            expect(request).toHaveBeenNthCalledWith(1, "msg.fetchMessages", {
                chatType: 2,
                peerUin: "123",
                count: 3,
            });

            const second = await internal.getMessageList("123", first.next, 1, "before", "desc");
            expect(second.data.map((message) => message.id)).toEqual(["older"]);
            expect(second).toMatchObject({ next: "older", prev: "older" });
            expect(request).toHaveBeenNthCalledWith(2, "msg.fetchMessages", {
                chatType: 2,
                peerUin: "123",
                count: 3,
                msgId: "newer",
            });

            const last = await internal.getMessageList("123", second.next, 1);
            expect(last.data.map((message) => message.id)).toEqual(["oldest"]);
            expect(last).not.toHaveProperty("next");
            expect(last).not.toHaveProperty("prev");
            await expect(internal.getMessageList("123", "oldest", 1)).resolves.toEqual({
                data: [],
            });

            const descending = await internal.getMessageList("123", undefined, 2, "before", "desc");
            expect(descending.data.map((message) => message.id)).toEqual(["newest", "newer"]);
            expect(descending.next).toBe(first.next);
        },
    );

    it.each(["after", "around"] as const)("明确拒绝 %s 分页", async (direction) => {
        const { internal, request } = createInternal();
        await expect(internal.getMessageList("123", "a", 1, direction)).rejects.toMatchObject({
            code: "UNSUPPORTED",
        });
        expect(request).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])("拒绝非法 limit %s", async (limit) => {
        const { internal, request } = createInternal();
        await expect(internal.getMessageList("123", undefined, limit)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        expect(request).not.toHaveBeenCalled();
    });
});
