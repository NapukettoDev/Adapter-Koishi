/** 跨模块使用的协议约定、媒体策略、路径校验和 IPC 错误。 */
import type { CanonicalElement } from "@napuketto/kernel";
import type { h } from "koishi";

/** 私聊 channelId 前缀。 */
export const PRIVATE_PREFIX = "private:";

/** Status：ONLINE=1 / CONNECT=2 / DISCONNECT=3（koishi Bot.status）。 */
export const BOT_STATUS = { ONLINE: 1, CONNECT: 2, DISCONNECT: 3 } as const;

export const DEFAULT_LOG_LEVEL = "info";

/** 与 Napuketto CLI 的账号格式一致，并保证账号目录名只有一个路径段。 */
export const SELF_ID_PATTERN = /^[0-9]{5,11}$/;

export function requireSelfId(value: unknown): string {
    if (typeof value !== "string" || !SELF_ID_PATTERN.test(value)) {
        throw new TypeError("selfId 必须是 5–11 位 ASCII 数字组成的 QQ 号字符串");
    }
    return value;
}

/** QQ NT uses Unix seconds or milliseconds depending on the wrapper version. */
export function normalizeMessageTime(raw: unknown): number | undefined {
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        return undefined;
    }
    const timestamp = value < 1e12 ? value * 1000 : value;
    return timestamp <= 8.64e15 ? timestamp : undefined;
}

/** koishi h() 工厂最小面（type/attrs → 元素；单测用 mock 实现）。 */
export type HFn<Element = { type: string; attrs: Record<string, unknown>; toString(): string }> = (
    type: string,
    attrs?: Record<string, unknown>,
    ...children: unknown[]
) => Element;

/**
 * koishi h() 工厂适配（apply() 层调用，绑定生产 h）。
 *
 * h 可调用（Element 工厂），类型宽适配规避逆变检查（koishi h 的实际签名
 * 比 HFn 更复杂，cast 到最小面即可——运行时行为不变）。单测用 mockH()
 * （tests/helpers/events.ts），不 import koishi 主包（docs/guides/development.md 单测边界）。
 */
export function bindKoishiH(koishiH: typeof h): HFn<ReturnType<typeof h>> {
    const factory = koishiH as unknown as HFn<ReturnType<typeof h>>;
    return (type, attrs, ...children) => factory(type, attrs, ...children);
}

/** canonical 元素 → koishi 元素（数组）。 */
export function toKoishiElements<Element>(
    elements: CanonicalElement[],
    h: HFn<Element>,
): Element[] {
    return elements.map((element) => toKoishiElement(element, h));
}

/** 单个 canonical 元素 → koishi 元素。 */
function toKoishiElement<Element>(element: CanonicalElement, h: HFn<Element>): Element {
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

/**
 * IPC 层错误（协议级：超时 / 通道关闭 / 远端错误码）。
 *
 * 与 kernel 的 KernelError 区分：远端错误码是宽松 string（来自协议边界），
 * 不伪造 KernelErrorCode；插件侧 driver/events 层再按需映射。
 */
export class IpcError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = "IpcError";
        this.code = code;
    }
}
export const DEFAULT_REMOTE_MEDIA_POLICY = "public-only";
export const DEFAULT_LOCAL_FILE_POLICY = "allowlist";

export interface OutboundMediaPolicy {
    remoteMediaPolicy?: "compatible" | "public-only";
    localFilePolicy?: "legacy" | "allowlist";
    localMediaRoots?: string[];
}

/** 本地媒体路径不接受 UNC、设备路径、ADS 或 NUL。 */
export function isLocalPath(path: string): boolean {
    const withoutDrive = process.platform === "win32" ? path.replace(/^[a-z]:/i, "") : path;
    return !/^[\\/]{2}/.test(path) && !withoutDrive.includes(":") && !path.includes("\0");
}
