/**
 * 预热阶段的 Computed 策略求值（docs/internals/bot.md）。
 *
 * koishi 的 `autoAssign` / `autoAuthorize` 支持函数或 Eval 表达式，按真实 session
 * 求值。预热发生在 dispatch 之前，此时只有事件字段是最终值；`user` / `channel` /
 * `guild` / `argv` 等可能由 Koishi 在 dispatch 期间延迟加载或改写。
 *
 * 因此这里只对「只读取不可变 session 字段」的纯函数求值：代理会拦截白名单之外的
 * 属性访问，一旦函数读取延迟字段、调用 session 方法或试图改写 session，就放弃预热
 * 并交给 Koishi 自己求值。Eval 表达式与静态值走各自分支，不猜测。
 */

import type { Computed } from "koishi";

/** 构造 session 时已经写入、dispatch 前不会再变的字段。 */
const SAFE_SESSION_FIELDS = new Set([
    "type",
    "subtype",
    "selfId",
    "platform",
    "timestamp",
    "userId",
    "operatorId",
    "channelId",
    "guildId",
    "messageId",
    "isDirect",
    "id",
    "sn",
    "uid",
    "gid",
    "cid",
    "fid",
    "sid",
]);

/** 预热策略求值结果：resolved 可直接用；deferred 表示交给 Koishi。 */
export type PolicyResolution<T> =
    | { readonly kind: "resolved"; readonly value: T }
    | { readonly kind: "deferred" };

interface GuardState {
    /** 函数是否访问过白名单外字段（即使它自己 catch 了异常）。 */
    unsafe: boolean;
    /** 函数调用结束后，代理退化为普通只读快照，避免诊断/断言被 strict 陷阱打断。 */
    done: boolean;
}

class UnsafePolicyAccess extends Error {}

function deferred<T>(): PolicyResolution<T> {
    return { kind: "deferred" };
}

/** 只允许读取不可变 session 字段的只读代理。 */
function guardSession(session: object, state: GuardState): object {
    // 先把安全字段读成普通数据属性：真实 satori Session 的这些字段是访问器，
    // 内部会读 this.event；直接代理真实 session 会把 event 也暴露给函数。
    const snapshot: Record<string, unknown> = {};
    for (const field of SAFE_SESSION_FIELDS) {
        try {
            snapshot[field] = Reflect.get(session, field);
        } catch {
            // 字段读取失败时不放入快照；函数访问该字段会按 unsafe 处理。
        }
    }
    const safe = Object.freeze(snapshot);
    const deny = (property: PropertyKey): never => {
        state.unsafe = true;
        throw new UnsafePolicyAccess(String(property));
    };
    return new Proxy(safe, {
        get(target, property, receiver) {
            if (state.done) return Reflect.get(target, property, receiver);
            // 符号属性（inspect / toPrimitive 等）不是 session 业务字段，放行但不可写。
            if (typeof property === "symbol") return Reflect.get(target, property, receiver);
            if (!Object.hasOwn(target, property)) return deny(property);
            return Reflect.get(target, property, receiver);
        },
        has(target, property) {
            if (state.done) return Reflect.has(target, property);
            if (typeof property === "symbol") return Reflect.has(target, property);
            if (!Object.hasOwn(target, property)) return deny(property);
            return true;
        },
        getOwnPropertyDescriptor(target, property) {
            if (state.done) return Reflect.getOwnPropertyDescriptor(target, property);
            if (typeof property === "symbol") {
                return Reflect.getOwnPropertyDescriptor(target, property);
            }
            if (!Object.hasOwn(target, property)) return deny(property);
            return Reflect.getOwnPropertyDescriptor(target, property);
        },
        ownKeys(target) {
            // 枚举会暴露「哪些字段存在」的差异（例如 user 是否已延迟加载），不可信。
            if (!state.done) state.unsafe = true;
            return Reflect.ownKeys(target);
        },
        set(_target, property) {
            return deny(property);
        },
        defineProperty(_target, property) {
            return deny(property);
        },
        deleteProperty(_target, property) {
            return deny(property);
        },
    });
}

/** autoAssign 的合法结果（koishi `Computed<boolean>`）。 */
export function isAssignPolicy(value: unknown): value is boolean {
    return typeof value === "boolean";
}

/** autoAuthorize 的合法结果（koishi `Computed<number>`，natural）。 */
export function isAuthorizePolicy(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 解析一个 Computed：静态值直接校验；函数仅在可安全求值时使用；Eval 一律交给 Koishi。 */
export function resolvePolicy<T>(
    source: Computed<T>,
    session: object,
    isValid: (value: unknown) => value is T,
): PolicyResolution<T> {
    // 函数 / Eval 表达式之外的原始值（含 undefined）只接受明确合法的静态值。
    if (typeof source !== "function") {
        // Eval.Expr 是对象；预热阶段没有可靠方式复现 Koishi 的延迟字段求值环境。
        if (typeof source === "object" && source !== null) return deferred();
        return isValid(source) ? { kind: "resolved", value: source } : deferred();
    }

    const state: GuardState = { unsafe: false, done: false };
    try {
        // async 函数不符合 Computed 的同步契约；调用会提前触发副作用，直接跳过。
        if (source.constructor?.name === "AsyncFunction") return deferred();
        let value: unknown;
        try {
            value = Reflect.apply(source, null, [guardSession(session, state)]);
        } finally {
            // 调用结束后允许诊断/断言读取同一代理，不再触发 strict 陷阱。
            state.done = true;
        }
        // 函数可能 catch 代理异常后返回兜底值；只要碰过白名单外字段就不能信。
        if (state.unsafe) return deferred();
        return isValid(value) ? { kind: "resolved", value } : deferred();
    } catch {
        return deferred();
    }
}
