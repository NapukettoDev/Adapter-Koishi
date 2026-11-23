import { fileURLToPath } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import { IpcError, nonBlank } from "../../shared.js";

/** koishi 元素宽松结构（h() 元素，不 import koishi 主包）。 */
interface LooseElement {
    type: string;
    attrs?: Record<string, unknown>;
    children?: unknown[];
}

/** http(s) URL 判断（远程资源透传，internal.sendMessage 下载后发送）。 */
function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/** file: 协议判断（本地文件 URL，redposter 等用 pathToFileURL 生成）。 */
function isFileUrl(value: string): boolean {
    return /^file:\/\//i.test(value);
}

/** Map Koishi containers to ordered, nonempty QQ messages. */
export function toCanonicalMessages(content: unknown): CanonicalElement[][] {
    const messages: CanonicalElement[][] = [];
    let elements: CanonicalElement[] = [];
    let paragraphBreak = false;
    const flush = () => {
        if (elements.length !== 0) {
            messages.push(elements);
            elements = [];
        }
        paragraphBreak = false;
    };
    const append = (element: CanonicalElement) => {
        if (element.type === "text" && element.text === "") return;
        const previous = elements.at(-1);
        if (
            paragraphBreak &&
            previous !== undefined &&
            !(previous.type === "text" && previous.text.endsWith("\n")) &&
            !(element.type === "text" && element.text.startsWith("\n"))
        ) {
            elements.push({ type: "text", text: "\n" });
        }
        paragraphBreak = false;
        elements.push(element);
    };
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            append({ type: "text", text: value });
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item);
        } else if (isLooseElement(value)) {
            const attrs = value.attrs ?? {};
            const children = Array.isArray(value.children) ? value.children : [];
            if (value.type === "message") {
                flush();
                if (!attrs["forward"]) visit(children);
                flush();
            } else if (value.type === "p") {
                paragraphBreak = true;
                visit(children);
                paragraphBreak = true;
            } else if (value.type === "author") {
                // QQ always supplies the logged-in account as the author.
            } else if (Object.hasOwn(elementHandlers, value.type)) {
                const result = elementHandlers[value.type]?.(value, attrs);
                if (result !== undefined) append(result);
            } else if (children.length > 0) {
                visit(children);
            } else {
                append({ type: "text", text: "[unsupported]" });
            }
        } else if (typeof value === "number" || typeof value === "boolean") {
            append({ type: "text", text: String(value) });
        }
    };
    visit(content);
    flush();
    return messages;
}

/** 单独使用元素转换时，返回展平的 canonical 元素。 */
export function toCanonicalElements(content: unknown): CanonicalElement[] {
    return toCanonicalMessages(content).flat();
}

/** 宽松结构判断。 */
function isLooseElement(value: unknown): value is LooseElement {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as LooseElement).type === "string"
    );
}

function takeId(attrs: Record<string, unknown>): string | undefined {
    const id = attrs["id"];
    return nonBlank(typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id);
}

/** 本地文件路径规范化：Windows 反斜杠 → 正斜杠（NT rich media 契约）。 */
function normalizeMediaPath(path: string): string {
    return path.replace(/\\/g, "/");
}

/** 媒体元素（img/image/audio/video）：src 空 → 原样文本；本地路径/file:// → canonical 媒体；http(s) URL 透传（发送前下载）。 */
function mediaElement(
    attrs: Record<string, unknown>,
    kind: "image" | "voice" | "video",
): CanonicalElement {
    const src = nonBlank(attrs["src"]);
    if (src === undefined) {
        throw new IpcError("媒体元素需要非空 src", "INVALID_PARAM");
    }
    const toMedia = (path: string): CanonicalElement => {
        if (kind === "image") {
            return { type: "image", path };
        }
        return kind === "voice" ? { type: "voice", path } : { type: "video", path };
    };
    // file:// URL → 转真实本地路径（fileURLToPath），避免带协议前缀透传给
    // wrapper.node 导致 rich media transfer failed（redposter 实证）
    if (isFileUrl(src)) {
        try {
            return toMedia(normalizeMediaPath(fileURLToPath(src)));
        } catch {
            throw new IpcError("本地媒体 file URL 格式无效", "INVALID_PARAM");
        }
    }
    if (isHttpUrl(src) || /^data:/i.test(src)) {
        // 远程 URL 透传：internal.sendMessage 的 downloadRemoteMedia 下载到本地
        // 临时文件后发送；下载失败回退占位文本（media.ts）
        return toMedia(src);
    }
    // 普通本地路径同样规范化（2026-08-09：redposter 实证 file:// 转路径后仍
    // rich media transfer failed——Windows 反斜杠路径透传给 NT 读不到，
    // 需统一转正斜杠；Electron/Chromium 内部按 URL 语义处理路径）
    return toMedia(normalizeMediaPath(src));
}

/** 元素类型 → 处理器（判别式映射表；未收录类型走默认降级 text）。 */
const elementHandlers: Record<
    string,
    (element: LooseElement, attrs: Record<string, unknown>) => CanonicalElement
> = {
    text: (element, attrs) => {
        // koishi text 元素内容在 attrs.content（napcat 实证），children 兜底
        const content = String(attrs["content"] ?? "");
        const childrenText =
            element.children?.filter((child) => typeof child === "string").join("") ?? "";
        return { type: "text", text: content !== "" ? content : childrenText };
    },
    br: () => ({ type: "text", text: "\n" }),
    at: (_element, attrs) => {
        const type = attrs["type"];
        const id =
            type === "all"
                ? "all"
                : type === undefined && attrs["role"] === undefined
                  ? takeId(attrs)
                  : undefined;
        return id === undefined
            ? { type: "text", text: nonBlank(attrs["name"]) ? `@${attrs["name"]}` : "[@]" }
            : { type: "at", target: id };
    },
    img: (_element, attrs) => mediaElement(attrs, "image"),
    // koishi 标准图片元素是 img（h("img", ...)），兼容旧 image 写法
    image: (_element, attrs) => mediaElement(attrs, "image"),
    face: (_element, attrs) => {
        const id = takeId(attrs);
        return id === undefined ? { type: "text", text: "[face]" } : { type: "face", id };
    },
    audio: (_element, attrs) => mediaElement(attrs, "voice"),
    // koishi 视频元素：h("video", { src }) / h("video", ...)（OneBot video 段）
    video: (_element, attrs) => mediaElement(attrs, "video"),
    quote: (_element, attrs) => {
        const id = takeId(attrs);
        return id === undefined || attrs["forward"]
            ? { type: "text", text: "[reply]" }
            : { type: "reply", messageId: id };
    },
};
