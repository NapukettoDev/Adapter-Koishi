/**
 * elements.ts：canonical 元素 → koishi 元素（纯函数，docs/internals/events.md）。
 *
 * 元素映射（canonical → koishi）：
 *  - text → h("text", { content })
 *  - at → h.at（target "all" 原样）
 *  - image → h("img", ...)（koishi 标准元素是 img，onebot 实证；url 优先，path 兜底）
 *  - face → h("face", { id })
 *  - voice → h.audio（url 优先，path 兜底）
 *  - reply → h.quote
 *  - 其他 → h("text", { content: "[type]" }) 占位
 *
 * ⚠️ text 元素必须 attrs.content（2026-08-09 修复）：satorijs Element.toString
 * 对 `type==="text" && "content" in attrs` 返回纯文本；content 放 children 会
 * 渲染 `<text>...</text>` 标签，content getter（elements.join）返回 XML → koishi
 * 指令系统无法提取纯文本。
 *
 * h 依赖注入：生产环境 apply() 传 koishi 的 `h`；单测传内存 mock
 * （koishi 主包 import 会初始化 loader，单测环境崩溃）。
 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { h } from "koishi";

/** koishi h() 工厂最小面（type/attrs → 元素；单测用 mock 实现）。 */
export type HFn = (
    type: string,
    attrs?: Record<string, unknown>,
    ...children: unknown[]
) => { type: string; attrs: Record<string, unknown>; toString(): string };

/**
 * koishi h() 工厂适配（apply() 层调用，绑定生产 h）。
 *
 * h 可调用（Element 工厂），类型宽适配规避逆变检查（koishi h 的实际签名
 * 比 HFn 更复杂，cast 到最小面即可——运行时行为不变）。单测用 mockH()
 * （test-utils.ts），不 import koishi 主包（docs/guides/development.md 单测边界）。
 */
export function bindKoishiH(koishiH: typeof h): HFn {
    const factory = koishiH as unknown as HFn;
    return (type, attrs, ...children) => factory(type, attrs, ...children);
}

/** canonical 元素 → koishi 元素（数组）。 */
export function toKoishiElements(elements: CanonicalElement[], h: HFn): unknown[] {
    return elements.map((element) => toKoishiElement(element, h));
}

/** 单个 canonical 元素 → koishi 元素。 */
function toKoishiElement(element: CanonicalElement, h: HFn): unknown {
    switch (element.type) {
        case "text":
            // ⚠️ 标准 text 元素 = h("text", { content })（satorijs element 实证，
            // 2026-08-09 修复）：attrs 必须带 content，toString 才返回纯文本；
            // 之前 h("text", {}, text)（content 在 children）toString 走通用分支
            // 渲染成 `<text>echo 1</text>`，content getter（elements.join）返回
            // XML 标签 → koishi 指令系统提取不到纯文本，指令无响应。
            return h("text", { content: element.text });
        case "at":
            return h("at", { id: element.target });
        case "image":
            // koishi 标准图片元素是 img（onebot 实证）；url 优先，path 兜底
            return h("img", { src: element.url ?? element.path });
        case "face":
            return h("face", { id: element.id });
        case "voice":
            return h("audio", { src: element.url ?? element.path });
        case "reply":
            return h("quote", { id: element.messageId });
        default:
            // video/file/forward/json/xml/unknown：占位（后续扩充）
            return h("text", { content: `[${element.type}]` });
    }
}
