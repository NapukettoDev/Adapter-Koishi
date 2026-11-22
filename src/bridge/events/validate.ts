/**
 * validate.ts：kernel 事件载荷的结构校验（纯函数）。
 *
 * IPC 的 zod schema 只保证 `{ service, name, args }` 外壳；`args[0]` 来自
 * 原生事件的 `unknown`。进入元素转换前先确认适配器实际依赖的字段，
 * 避免 `msg.elements.map` / `element.elementType` 之类的隐式断言把坏事件
 * 变成未处理异常。
 */
import { ChatType, type RawMessage } from "@napuketto/kernel";

/** 校验结果：通过时收窄为 RawMessage，失败时给出不含载荷内容的诊断。 */
export type RawMessageValidation =
    | { ok: true; message: RawMessage }
    | { ok: false; reason: string };

const CHAT_TYPES = new Set<number>(Object.values(ChatType));

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验一条 RawMessage；读取字段抛错也按无效事件处理。 */
export function validateRawMessage(value: unknown): RawMessageValidation {
    try {
        return inspect(value);
    } catch {
        return { ok: false, reason: "读取事件字段失败" };
    }
}

function inspect(value: unknown): RawMessageValidation {
    if (!isRecord(value)) {
        return { ok: false, reason: "不是对象" };
    }
    if (typeof value["msgId"] !== "string" || value["msgId"] === "") {
        return { ok: false, reason: "缺少 msgId" };
    }
    if (
        typeof value["chatType"] !== "number" ||
        !Number.isSafeInteger(value["chatType"]) ||
        !CHAT_TYPES.has(value["chatType"])
    ) {
        return { ok: false, reason: "chatType 非法" };
    }
    // senderUin / peerUin 由 adapt 以空串兜底（undefined 或 null），缺省不视为坏事件；
    // 出现非空值时必须与 kernel 契约一致为字符串。
    if (value["senderUin"] != null && typeof value["senderUin"] !== "string") {
        return { ok: false, reason: "senderUin 不是字符串" };
    }
    if (value["peerUin"] != null && typeof value["peerUin"] !== "string") {
        return { ok: false, reason: "peerUin 不是字符串" };
    }
    const elements = value["elements"];
    if (!Array.isArray(elements)) {
        return { ok: false, reason: "elements 不是数组" };
    }
    for (let index = 0; index < elements.length; index += 1) {
        const element: unknown = elements[index];
        if (
            !isRecord(element) ||
            typeof element["elementType"] !== "number" ||
            !Number.isSafeInteger(element["elementType"])
        ) {
            return { ok: false, reason: `elements[${index}] 缺少合法 elementType` };
        }
    }
    return { ok: true, message: value as unknown as RawMessage };
}
