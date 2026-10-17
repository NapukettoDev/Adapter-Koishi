/**
 * elements.test.ts：koishi 元素 → canonical 反向映射单测（design.md §5.10）。
 */

import { fileURLToPath } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toCanonicalElements } from "../elements.js";

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

    it("video 缺 src → 降级 text（不丢内容）", () => {
        const broken = makeElement("video", {}, ["视频"]);
        const out = toCanonicalElements([broken]) as CanonicalElement[];
        expect(out[0]).toMatchObject({ type: "text" });
        expect((out[0] as { text: string }).text).toContain("video");
    });

    it("未知元素 → 降级 text（toString 保内容）", () => {
        const file = makeElement("file", { src: "x.zip" }, ["内容"]);
        const out = toCanonicalElements([file]) as CanonicalElement[];
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ type: "text" });
        expect((out[0] as { text: string }).text).toContain("file");
        expect((out[0] as { text: string }).text).toContain("内容");
    });

    it("缺失关键 attrs → 降级 text", () => {
        const brokenAt = makeElement("at", {});
        const out = toCanonicalElements([brokenAt]) as CanonicalElement[];
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
