/**
 * elements.test.ts：canonical 元素 → koishi 元素映射单测。
 */

import { pathToFileURL } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { describe, expect, it } from "vitest";
import { toKoishiElements } from "../../../../src/shared.js";
import { mockH } from "../../../helpers/events.js";

describe("toKoishiElements", () => {
    const h = mockH();

    it("text → h('text', { content })（toString 纯文本，非 <text> 标签）", () => {
        const elements = toKoishiElements([{ type: "text", text: "你好" }], h);
        const element = elements[0] as { attrs?: Record<string, unknown> };
        expect(element.attrs?.["content"]).toBe("你好");
        expect(String(elements[0])).toBe("你好");
        expect(String(elements[0])).not.toContain("<text");
    });

    it("at 使用已确认的 QQ 号和全体类型，未知 UID 降为安全文本", () => {
        const elements = toKoishiElements(
            [
                { type: "at", target: "20001", display: '名"<&' },
                { type: "at", target: "all" },
                { type: "at", target: "u_123", display: "<at/>" },
            ],
            h,
        );
        expect(elements.map(String)).toEqual([
            '<at id="20001" name="名&quot;&lt;&amp;"/>',
            '<at type="all"/>',
            "@&lt;at/&gt;",
        ]);
    });

    it("视频、文件与有来源的媒体保留类型，空来源降级", () => {
        const elements = toKoishiElements(
            [
                { type: "video", path: "/a.mp4", url: " ", durationSec: 9 },
                { type: "file", path: "/a.txt", name: "附件" },
                { type: "image", path: "", url: " " },
                { type: "voice", path: "" },
                { type: "file", path: "", name: "未下载" },
            ],
            h,
        );
        expect(elements).toMatchObject([
            { type: "video", attrs: { src: pathToFileURL("/a.mp4").href, duration: 9 } },
            { type: "file", attrs: { src: pathToFileURL("/a.txt").href, title: "附件" } },
            { type: "text", attrs: { content: "[image]" } },
            { type: "text", attrs: { content: "[voice]" } },
            { type: "text", attrs: { content: "[file]" } },
        ]);
    });

    it("image → h('img')（koishi 标准元素；url 优先，path 兜底）", () => {
        const withUrl = toKoishiElements(
            [{ type: "image", path: "/local/1.png", url: "https://x/1.png" }],
            h,
        );
        expect(String(withUrl[0])).toContain("https://x/1.png");
        expect(String(withUrl[0])).toContain("<img");

        const pathOnly = toKoishiElements([{ type: "image", path: "/local/2.png" }], h);
        expect(String(pathOnly[0])).toContain("/local/2.png");
        expect(String(pathOnly[0])).toContain("<img");
    });

    it("face → h('face', { id })", () => {
        const face = toKoishiElements([{ type: "face", id: "178" }], h);
        expect(String(face[0])).toContain('id="178"');
    });

    it("voice → h.audio", () => {
        const voice = toKoishiElements(
            [{ type: "voice", path: "/a.silk", url: "https://x/a.silk" }],
            h,
        );
        expect(String(voice[0])).toContain("https://x/a.silk");
    });

    it("reply → h.quote", () => {
        const reply = toKoishiElements([{ type: "reply", messageId: "12345" }], h);
        expect(String(reply[0])).toContain("12345");
    });

    it("未知元素 → h('text', { content: '[type]' }) 占位", () => {
        const unknown = toKoishiElements([{ type: "unknown", raw: {} } as CanonicalElement], h);
        expect(String(unknown[0])).toBe("[unknown]");
    });

    it("混合元素顺序保留（text 纯文本 + at 标签）", () => {
        const elements = toKoishiElements(
            [
                { type: "text", text: "早上好" },
                { type: "at", target: "20001" },
                { type: "text", text: "！" },
            ],
            h,
        );
        const joined = elements.map(String).join("");
        // 顺序保留：text（纯文本）→ at → text（纯文本）
        const atIndex = joined.indexOf('<at id="20001"');
        expect(atIndex).toBeGreaterThan(0);
        expect(joined.startsWith("早上好")).toBe(true);
        expect(joined.endsWith("！")).toBe(true);
        expect(joined).not.toContain("<text>");
    });
});
