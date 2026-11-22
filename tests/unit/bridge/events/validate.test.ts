/** validate.test.ts：RawMessage 结构校验（元素转换前）。 */
import { describe, expect, it } from "vitest";
import { validateRawMessage } from "../../../../src/bridge/events/validate.js";

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        msgId: "m1",
        msgTime: "1700000000",
        msgType: 9,
        chatType: 2,
        peerUid: "u_peer",
        peerUin: "10001",
        senderUid: "u_sender",
        senderUin: "20001",
        elements: [{ elementType: 1, textElement: { content: "hi" } }],
        ...overrides,
    };
}

describe("validateRawMessage", () => {
    it("合法消息通过并收窄为 RawMessage", () => {
        const message = rawMessage();
        expect(validateRawMessage(message)).toEqual({ ok: true, message });
    });

    it.each([
        ["null", null],
        ["字符串", "raw"],
        ["数组", []],
    ])("%s → 不是对象", (_label, value) => {
        expect(validateRawMessage(value)).toMatchObject({ ok: false });
    });

    it("缺少 msgId / chatType 非法 / senderUin 非字符串", () => {
        expect(validateRawMessage(rawMessage({ msgId: "" }))).toMatchObject({
            ok: false,
            reason: "缺少 msgId",
        });
        expect(validateRawMessage(rawMessage({ chatType: 9 }))).toMatchObject({
            ok: false,
            reason: "chatType 非法",
        });
        expect(validateRawMessage(rawMessage({ senderUin: 20001 }))).toMatchObject({
            ok: false,
            reason: "senderUin 不是字符串",
        });
    });

    it("senderUin / peerUin 缺省仍通过（沿用空串兜底）", () => {
        const { senderUin: _senderUin, peerUin: _peerUin, ...message } = rawMessage();
        expect(validateRawMessage(message)).toMatchObject({ ok: true });
    });

    it("elements 不是数组 / 元素缺少合法 elementType", () => {
        expect(validateRawMessage(rawMessage({ elements: "x" }))).toMatchObject({
            ok: false,
            reason: "elements 不是数组",
        });
        expect(validateRawMessage(rawMessage({ elements: [null] }))).toMatchObject({
            ok: false,
            reason: "elements[0] 缺少合法 elementType",
        });
        expect(validateRawMessage(rawMessage({ elements: [{ elementType: "1" }] }))).toMatchObject({
            ok: false,
            reason: "elements[0] 缺少合法 elementType",
        });
    });

    it("字段读取自身抛错 → 无效事件，不向调用方抛错", () => {
        const bad = {
            ...rawMessage(),
            get elements(): unknown {
                throw new Error("getter 爆炸");
            },
        };
        expect(validateRawMessage(bad)).toEqual({ ok: false, reason: "读取事件字段失败" });
    });
});
