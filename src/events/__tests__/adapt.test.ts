/**
 * adapt.test.ts：RawMessage → koishi session 字段单测。
 */

import { describe, expect, it, vi } from "vitest";
import { adaptRawMessage, adaptRawMessageWithMedia } from "../adapt.js";
import { normalizeMessageTime } from "../message-time.js";
import { makeRawMessage as makeMsg, mockH } from "../test-utils.js";
import { enrichReceiveVoice } from "../voice-decode.js";

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

    it("临时会话 → type=message + subtype=private + guildId=群号", () => {
        const session = adaptRawMessage(makeMsg({ chatType: 100, peerUin: "10001" }), adaptOpts());
        expect(session.type).toBe("message");
        expect(session.subtype).toBe("private");
        expect(session.channelId).toBe("private:20001");
        expect(session.guildId).toBe("10001");
        expect(session.isDirect).toBe(true);
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
