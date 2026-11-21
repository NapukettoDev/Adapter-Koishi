/**
 * test-utils.ts：事件桥测试共享设施——内存 mock h() 工厂。
 *
 * koishi 主包 import 会初始化 loader（vitest 环境崩溃），因此测试用 mock h：
 * 产出 { type, attrs, children, toString } 形状，验证元素映射正确。
 */
import type { RawMessage } from "@napuketto/kernel";
import type { HFn } from "./elements.js";

export function makeRawMessage(overrides: Partial<RawMessage> = {}): RawMessage {
    return {
        msgId: "m1",
        msgSeq: "1",
        msgTime: "1700000000",
        msgType: 9,
        chatType: 2,
        peerUid: "u_peer",
        peerUin: "10001",
        senderUid: "u_sender",
        senderUin: "20001",
        peerName: "测试群",
        sendNickName: "小明",
        elements: [{ elementType: 1, textElement: { content: "你好" } }],
        ...overrides,
    };
}

/** 内存 h() 工厂（koishi h 的宽松替代，对齐 satorijs element 渲染语义）。 */
export function mockH(): HFn {
    return (type, attrs = {}, ...children) => {
        const attrsStr = Object.entries(attrs)
            .map(([key, value]) => ` ${key}="${String(value)}"`)
            .join("");
        const content = children.map((child) => String(child)).join("");
        return {
            type,
            attrs,
            // satorijs Element.toString：text 元素（attrs.content）返回纯文本；
            // 其他元素渲染 XML 标签（真实行为，2026-08-09 对齐——旧实现全部
            // 渲染标签掩盖了 text 结构错误）。
            toString: () => {
                if (type === "text" && "content" in attrs) {
                    return String(attrs["content"] ?? "");
                }
                return `<${type}${attrsStr}>${content}</${type}>`;
            },
        };
    };
}
