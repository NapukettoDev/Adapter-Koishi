/**
 * internal.test.ts：NapukettoInternal 单测（mock request 注入，docs/internals/actions.md）。
 *
 * 语音用例（2026-08-23）：sendMessage 里 audio → voice 后统一转 silk
 * （mock @napuketto/media，真实文件头判断在 media.test.ts 覆盖）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const internal = new NapukettoInternal({ request });
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

    it("getMessageList → msg.fetchMessages（before → msgId，next=末条）", async () => {
        const { internal, request } = createInternal(async () => [{ msgId: "a" }, { msgId: "b" }]);
        const list = await internal.getMessageList("123", "a", 10);
        expect(request).toHaveBeenCalledWith("msg.fetchMessages", {
            chatType: 2,
            peerUin: "123",
            count: 10,
            msgId: "a",
        });
        expect(list).toEqual({ data: [{ msgId: "a" }, { msgId: "b" }], next: "b" });
    });

    it("getMessageList：无 before → 不带 msgId，count 默认 20", async () => {
        const { internal, request } = createInternal(async () => []);
        await internal.getMessageList("123");
        expect(request).toHaveBeenCalledWith("msg.fetchMessages", {
            chatType: 2,
            peerUin: "123",
            count: 20,
        });
    });

    it("getMessageList：末条无 msgId → 不带 next", async () => {
        const { internal } = createInternal(async () => [{ text: "x" }]);
        const list = await internal.getMessageList("123");
        expect(list).toEqual({ data: [{ text: "x" }] });
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
