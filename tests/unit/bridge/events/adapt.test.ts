/**
 * adapt.test.ts：RawMessage → koishi session 字段单测。
 */

import { ElementType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import { adaptRawMessage, adaptRawMessageWithMedia } from "../../../../src/bridge/events/adapt.js";
import { enrichReceiveVoice } from "../../../../src/bridge/events/voice-decode.js";
import { normalizeMessageTime } from "../../../../src/shared.js";
import { makeRawMessage as makeMsg, mockH } from "../../../helpers/events.js";

/** 默认适配选项（mock h）。 */
function adaptOpts(overrides: Partial<{ selfId: string; platform: string }> = {}): {
    selfId: string;
    platform: string;
    h: ReturnType<typeof mockH>;
} {
    return {
        selfId: overrides.selfId ?? "10086",
        platform: overrides.platform ?? "onebot",
        h: mockH(),
    };
}

describe("adaptRawMessage", () => {
    it("群聊 → type=message + subtype=group + channelId=guildId=群号", () => {
        const session = adaptRawMessage(makeMsg(), adaptOpts());
        expect(session.type).toBe("message");
        expect(session.subtype).toBe("group");
        expect(session.selfId).toBe("10086");
        expect(session.platform).toBe("onebot");
        expect(session.userId).toBe("20001");
        expect(session.channelId).toBe("10001");
        expect(session.guildId).toBe("10001");
        expect(session.messageId).toBe("m1");
        expect(session.isDirect).toBe(false);
    });

    it("私聊 → type=message + subtype=private + channelId=private:+senderUin", () => {
        const session = adaptRawMessage(
            makeMsg({ chatType: 1, peerUin: "20001", peerUid: "u_sender" }),
            adaptOpts(),
        );
        expect(session.type).toBe("message");
        expect(session.subtype).toBe("private");
        expect(session.channelId).toBe("private:20001");
        expect(session.guildId).toBeUndefined();
        expect(session.isDirect).toBe(true);
    });

    it("临时会话使用独立频道，peerUin 指向对端而非群号", () => {
        const session = adaptRawMessage(
            makeMsg({
                chatType: 100,
                peerUin: "20001",
                senderUin: "10086",
                guildId: "10001",
            }),
            adaptOpts(),
        );
        expect(session).toMatchObject({
            type: "message",
            subtype: "private",
            userId: "10086",
            channelId: "private:temp:20001",
            isDirect: true,
        });
        expect(session).not.toHaveProperty("guildId");
    });

    it("同一消息中转换 UIN、@自己和@全体，未知 UID 保留转义文本", () => {
        const session = adaptRawMessage(
            makeMsg({
                elements: [
                    {
                        elementType: 1,
                        textElement: { atType: 2, atUid: "u_sender", content: "@小明" },
                    },
                    { elementType: 1, textElement: { atType: 4, content: "@机器人" } },
                    { elementType: 1, textElement: { atType: 1, content: "@全体成员" } },
                    {
                        elementType: 1,
                        textElement: { atType: 2, atUid: "u_missing", content: '@<img src="x">&' },
                    },
                ],
            }),
            adaptOpts(),
        );
        expect(session.elements).toMatchObject([
            { type: "at", attrs: { id: "20001", name: "小明" } },
            { type: "at", attrs: { id: "10086", name: "机器人" } },
            { type: "at", attrs: { type: "all" } },
            { type: "text", attrs: { content: '@<img src="x">&' } },
        ]);
        expect(String(session.elements?.[3])).toBe('@&lt;img src="x"&gt;&amp;');
    });

    it("引用和作者走结构化字段，保留正文和群名片", () => {
        const session = adaptRawMessage(
            makeMsg({
                sendMemberName: "群名片",
                elements: [
                    {
                        elementType: ElementType.REPLY,
                        replyElement: {
                            replayMsgId: "90071992547409930",
                            replayMsgTime: "1700000000",
                            senderUid: "u_quoted",
                            senderUin: "30001",
                        },
                    },
                    { elementType: 1, textElement: { content: "回复" } },
                ],
            }),
            adaptOpts(),
        );
        expect(session.user).toEqual({ id: "20001", name: "小明" });
        expect(session.member).toMatchObject({ user: { id: "20001" }, nick: "群名片" });
        expect(session.quote).toEqual({
            id: "90071992547409930",
            user: { id: "30001" },
            timestamp: 1_700_000_000_000,
            createdAt: 1_700_000_000_000,
        });
        expect(session.elements?.map(String)).toEqual(["回复"]);
    });

    it("图片保留原生宽高，视频使用视频时长而非缩略图尺寸", () => {
        const session = adaptRawMessage(
            makeMsg({
                elements: [
                    {
                        elementType: ElementType.PIC,
                        picElement: {
                            picUrl: "https://example.test/a.png",
                            picWidth: 240,
                            picHeight: 320,
                        },
                    },
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: {
                            videoUrl: "https://example.test/a.mp4",
                            thumbWidth: 20,
                            thumbHeight: 30,
                            fileTime: 9,
                        },
                    },
                ],
            }),
            adaptOpts(),
        );
        expect(session.elements).toEqual([
            { type: "img", attrs: { src: "https://example.test/a.png", width: 240, height: 320 } },
            { type: "video", attrs: { src: "https://example.test/a.mp4", duration: 9 } },
        ]);
    });

    it("缺少可证实身份时不会构造空用户或空频道", () => {
        expect(() => adaptRawMessage(makeMsg({ senderUin: " " }), adaptOpts())).toThrow(
            "消息缺少可确认的账号、发送者或频道",
        );
        expect(() => adaptRawMessage(makeMsg({ peerUin: "" }), adaptOpts())).toThrow();
    });

    it("元素翻译：文本 → elements（content 由 elements getter 派生）", () => {
        const session = adaptRawMessage(makeMsg(), adaptOpts());
        // adapt 层只设 elements（不设 content——content setter 会 h.parse 覆盖 elements）
        expect(session.elements).toHaveLength(1);
        expect(String(session.elements?.[0])).toContain("你好");
        expect(session.content).toBeUndefined();
    });

    it.each([
        ["1700000000", 1_700_000_000_000],
        ["1700000000123", 1_700_000_000_123],
    ])("将实时消息时间 %s 统一为毫秒", (msgTime, expected) => {
        expect(adaptRawMessage(makeMsg({ msgTime }), adaptOpts()).timestamp).toBe(expected);
    });

    it("实时消息的非法时间回退到当前时间", () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_123);
        try {
            expect(adaptRawMessage(makeMsg({ msgTime: "NaN" }), adaptOpts()).timestamp).toBe(
                1_800_000_000_123,
            );
        } finally {
            now.mockRestore();
        }
    });
});

describe("adaptRawMessageWithMedia", () => {
    it("QQ 语音目录未知时保留原音频路径和同条消息的文本", async () => {
        const path = "nt_data/Ptt/a.silk";
        const session = await adaptRawMessageWithMedia(
            makeMsg({
                elements: [
                    { elementType: 4, pttElement: { filePath: path } },
                    { elementType: 1, textElement: { content: "你好" } },
                ],
            }),
            { ...adaptOpts(), enrichElements: (elements) => enrichReceiveVoice(elements) },
        );
        expect(session.elements).toMatchObject([
            { type: "audio", attrs: { src: path } },
            { type: "text", attrs: { content: "你好" } },
        ]);
    });

    it("富化失败 → 诊断后回退原始元素，消息仍可派发", async () => {
        const onError = vi.fn();
        const session = await adaptRawMessageWithMedia(makeMsg(), {
            ...adaptOpts(),
            enrichElements: async () => {
                throw new Error("silk 解码失败");
            },
            onError,
        });
        expect(session.elements).toHaveLength(1);
        expect(String(session.elements?.[0])).toContain("你好");
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: "silk 解码失败" }),
            "收向元素富化失败（回退原始元素）",
        );
    });

    it("诊断回调自身抛错也不阻断富化降级", async () => {
        const session = await adaptRawMessageWithMedia(makeMsg(), {
            ...adaptOpts(),
            enrichElements: async () => {
                throw new Error("silk 解码失败");
            },
            onError: () => {
                throw new Error("diagnostic boom");
            },
        });
        expect(String(session.elements?.[0])).toContain("你好");
    });
});

describe("normalizeMessageTime", () => {
    it("接受运行时数字和字符串时间戳", () => {
        expect(normalizeMessageTime(1_700_000_000)).toBe(1_700_000_000_000);
        expect(normalizeMessageTime(1_700_000_000_123)).toBe(1_700_000_000_123);
    });

    it.each([undefined, null, "", " ", "NaN", "-1", "0", "1e12", 1.5, Infinity, {}, 8.65e15])(
        "将非法时间 %j 视为缺失",
        (raw) => expect(normalizeMessageTime(raw)).toBeUndefined(),
    );
});
