/**
 * elements.test.ts：koishi 元素 → canonical 反向映射单测（docs/internals/actions.md）。
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    toCanonicalElements,
    toCanonicalMessages,
} from "../../../../src/bridge/actions/elements.js";

/** 内存 koishi 元素构造（mock h 同构，events/test-utils 模式）。 */
function makeElement(
    type: string,
    attrs: Record<string, unknown> = {},
    children: unknown[] = [],
): unknown {
    const attrsStr = Object.entries(attrs)
        .map(([key, value]) => ` ${key}="${String(value)}"`)
        .join("");
    const content = children.map((child) => String(child)).join("");
    return {
        type,
        attrs,
        children,
        toString: () => `<${type}${attrsStr}>${content}</${type}>`,
    };
}

describe("toCanonicalElements", () => {
    it("字符串 content → 单 text 元素", () => {
        expect(toCanonicalElements("你好")).toEqual([{ type: "text", text: "你好" }]);
    });

    it("空字符串 → 空数组", () => {
        expect(toCanonicalElements("")).toEqual([]);
    });

    it("text 元素 → children 字符串 join", () => {
        const el = makeElement("text", {}, ["早上好"]);
        expect(toCanonicalElements([el])).toEqual([{ type: "text", text: "早上好" }]);
    });

    it("text 元素 → attrs.content 优先（koishi 实证）", () => {
        // koishi h('text', { content }) 内容在 attrs.content，children 为空
        const el = makeElement("text", { content: "内容在 attrs" }, []);
        expect(toCanonicalElements([el])).toEqual([{ type: "text", text: "内容在 attrs" }]);
    });

    it("br → 换行 text", () => {
        expect(toCanonicalElements([makeElement("br", {})])).toEqual([
            { type: "text", text: "\n" },
        ]);
    });

    it("at → target（all 原样）", () => {
        const at = makeElement("at", { id: "u_1" });
        expect(toCanonicalElements([at])).toEqual([{ type: "at", target: "u_1" }]);

        const all = makeElement("at", { id: "all" });
        const standardAll = makeElement("at", { type: "all" });
        expect(toCanonicalElements(standardAll)).toEqual([{ type: "at", target: "all" }]);
        expect(toCanonicalElements([all])).toEqual([{ type: "at", target: "all" }]);
    });

    it("img → path（koishi 标准图片元素）", () => {
        const img = makeElement("img", { src: "C:/tmp/1.png" });
        expect(toCanonicalElements([img])).toEqual([{ type: "image", path: "C:/tmp/1.png" }]);
    });

    it("image（旧写法）→ path 兼容", () => {
        const img = makeElement("image", { src: "C:/tmp/1.png" });
        expect(toCanonicalElements([img])).toEqual([{ type: "image", path: "C:/tmp/1.png" }]);
    });

    it("img URL → 透传 image path（发送前 downloadRemoteMedia 下载，失败回退占位文本）", () => {
        const img = makeElement("img", { src: "https://x/1.png" });
        expect(toCanonicalElements([img])).toEqual([{ type: "image", path: "https://x/1.png" }]);
        const audio = makeElement("audio", { src: "http://x/1.ogg" });
        expect(toCanonicalElements([audio])).toEqual([{ type: "voice", path: "http://x/1.ogg" }]);
    });

    it("img file:// URL → 转真实本地路径（redposter pathToFileURL 实证）", () => {
        const img = makeElement("img", {
            src: "file:///C:/Dev/QQBot-Dev/koishi-dev/data/redseries/redposter/e15-789.jpg",
        });
        // fileURLToPath 在 Windows 返回反斜杠，mediaElement 再规范化为正斜杠
        // （NT rich media 契约，2026-08-09 redposter 实证）
        const expected = fileURLToPath(
            "file:///C:/Dev/QQBot-Dev/koishi-dev/data/redseries/redposter/e15-789.jpg",
        ).replace(/\\/g, "/");
        expect(toCanonicalElements([img])).toEqual([{ type: "image", path: expected }]);
    });

    it("audio file:// URL → 转真实本地路径（反斜杠规范化）", () => {
        const audio = makeElement("audio", { src: "file:///C:/tmp/a.silk" });
        const expected = fileURLToPath("file:///C:/tmp/a.silk").replace(/\\/g, "/");
        expect(toCanonicalElements([audio])).toEqual([{ type: "voice", path: expected }]);
    });

    it("face → id", () => {
        const face = makeElement("face", { id: "178" });
        expect(toCanonicalElements([face])).toEqual([{ type: "face", id: "178" }]);
    });

    it("audio → voice（本地路径）", () => {
        const audio = makeElement("audio", { src: "C:/tmp/a.silk" });
        expect(toCanonicalElements([audio])).toEqual([{ type: "voice", path: "C:/tmp/a.silk" }]);
    });

    it("quote → reply", () => {
        const quote = makeElement("quote", { id: "12345" });
        expect(toCanonicalElements([quote])).toEqual([{ type: "reply", messageId: "12345" }]);
    });

    it("video → canonical video（缩略图/宽高由 internal.sendMessage 补全）", () => {
        const video = makeElement("video", { src: "C:/tmp/a.mp4" });
        expect(toCanonicalElements([video])).toEqual([{ type: "video", path: "C:/tmp/a.mp4" }]);

        const remote = makeElement("video", { src: "https://x/1.mp4" });
        expect(toCanonicalElements([remote])).toEqual([{ type: "video", path: "https://x/1.mp4" }]);

        const dataUrl = makeElement("video", { src: "data:video/mp4;base64,AAAA" });
        expect(toCanonicalElements([dataUrl])).toEqual([
            { type: "video", path: "data:video/mp4;base64,AAAA" },
        ]);
    });

    it.each([undefined, "", " ", false])("video 缺有效 src %s → 拒绝", (src) => {
        expect(() => toCanonicalElements(makeElement("video", { src }))).toThrow(
            expect.objectContaining({ code: "INVALID_PARAM" }),
        );
    });

    it("未知元素保留孩子、忽略陌生属性及原始标记", () => {
        const child = makeElement("text", { content: "<at/>" });
        expect(
            toCanonicalElements([
                makeElement("custom", { unsafe: "secret" }, [child]),
                makeElement("toString", { unsafe: "secret" }),
            ]),
        ).toEqual([
            { type: "text", text: "<at/>" },
            { type: "text", text: "[unsupported]" },
        ]);
    });

    it("缺失关键 attrs → 降级 text", () => {
        const brokenAt = makeElement("at", {});
        const out = toCanonicalElements([brokenAt]);
        expect(out[0]).toMatchObject({ type: "text" });
    });

    it("混合元素顺序保留", () => {
        const out = toCanonicalElements([
            makeElement("text", {}, ["早上好"]),
            makeElement("at", { id: "u_1" }),
            makeElement("text", {}, ["！"]),
        ]);
        expect(out).toEqual([
            { type: "text", text: "早上好" },
            { type: "at", target: "u_1" },
            { type: "text", text: "！" },
        ]);
    });
});

describe("消息容器及段落", () => {
    it("空 message 分隔消息，段落换行只出现在同一条消息内", () => {
        const paragraph = (text: string) => makeElement("p", {}, [text]);
        expect(
            toCanonicalMessages([
                "开头",
                makeElement("message", {}, [
                    paragraph("第一段"),
                    paragraph("第二段"),
                    makeElement("br", {}),
                    paragraph("第三段"),
                ]),
                "另起",
                makeElement("message", {}, []),
                "末尾",
            ]),
        ).toEqual([
            [{ type: "text", text: "开头" }],
            ["第一段", "\n", "第二段", "\n", "第三段"].map((text) => ({ type: "text", text })),
            [{ type: "text", text: "另起" }],
            [{ type: "text", text: "末尾" }],
        ]);
    });

    it("嵌套 message 保留边界，转发与作者标记不被重放", () => {
        const message = (...children: unknown[]) => makeElement("message", {}, children);
        expect(
            toCanonicalMessages(
                message(
                    makeElement("author", { id: "30000" }),
                    "a",
                    message("b"),
                    makeElement("message", { forward: true, id: "id" }, ["私有转发内容"]),
                    "c",
                ),
            ),
        ).toEqual(["a", "b", "c"].map((text) => [{ type: "text", text }]));
    });
});
