/** 跨模块使用的协议约定、媒体策略、路径校验和 IPC 错误。 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { CanonicalElement } from "@napuketto/kernel";
import type { h } from "koishi";

/** 私聊 channelId 前缀。 */
export const PRIVATE_PREFIX = "private:";
export const TEMP_PREFIX = `${PRIVATE_PREFIX}temp:`;

export function qqId(value: unknown): string | undefined {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return String(value);
    }
    return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export function nonBlank(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

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
            return h("text", { content: element.text });
        case "at": {
            if (element.target === "all") {
                return h("at", { type: "all" });
            }
            const id = qqId(element.target);
            const name = nonBlank(element.display);
            return id === undefined
                ? h("text", { content: name === undefined ? "[@]" : `@${name}` })
                : h("at", { id, ...(name === undefined ? {} : { name }) });
        }
        case "image":
        case "voice":
        case "video":
        case "file": {
            const url = "url" in element ? nonBlank(element.url) : undefined;
            const path = nonBlank(element.path);
            const source = url ?? path;
            if (source === undefined) {
                return h("text", { content: `[${element.type}]` });
            }
            const src =
                isAbsolute(source) && isLocalPath(source) ? pathToFileURL(source).href : source;
            if (element.type === "image") {
                return h("img", { src, ...element.size });
            }
            if (element.type === "voice" || element.type === "video") {
                const duration =
                    element.type === "voice" && element.durationMs !== undefined
                        ? element.durationMs / 1000
                        : element.type === "video"
                          ? element.durationSec
                          : undefined;
                return h(element.type === "voice" ? "audio" : "video", {
                    src,
                    ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0
                        ? { duration }
                        : {}),
                });
            }
            const title = nonBlank(element.name);
            return h("file", { src, ...(title === undefined ? {} : { title }) });
        }
        case "face":
            return h("face", { id: element.id });
        case "reply":
            return nonBlank(element.messageId) === undefined
                ? h("text", { content: "[reply]" })
                : h("quote", { id: element.messageId });
        case "forward":
        case "json":
        case "xml":
            return h("text", { content: `[${element.type}]` });
        default:
            return h("text", { content: "[unknown]" });
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
