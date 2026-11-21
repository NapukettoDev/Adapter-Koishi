/**
 * access.ts：控制台登录面板的鉴权门槛（docs/internals/console.md）。
 *
 * Koishi 控制台的鉴权由 @koishijs/plugin-auth 经 `console/intercept` 串行事件实施：
 * DataService / addListener 的 `authority` 选项是门槛，拦截器比较 client.auth.authority。
 * 本模块只定义门槛、选项构造与本地复核判定（纯函数，不 import koishi 运行时），
 * 供 provider 与单测共用——登录数据推送、连接时拉取和三个控制事件必须同一门槛。
 */
import type { LoginPanelPayload } from "./types.js";

/** 管理员权限等级（Koishi 权限系统 3 = 管理员）。 */
export const LOGIN_PANEL_AUTHORITY = 3;

/** DataService / addListener 的鉴权选项。 */
export interface LoginPanelAccessOptions {
    authority: number;
}

/** 构造鉴权选项（每次返回新对象，避免调用方共享可变状态）。 */
export function loginPanelAccessOptions(): LoginPanelAccessOptions {
    return { authority: LOGIN_PANEL_AUTHORITY };
}

/** @koishijs/plugin-auth 注入到控制台客户端上的登录态（只取判定需要的字段）。 */
export interface ConsoleClientAuth {
    readonly authority: number;
    readonly expiredAt: number;
}

/** 控制台客户端的最小结构（auth 可选，便于单测注入无鉴权插件场景）。 */
export interface ConsoleAuthClient {
    // @koishijs/plugin-auth 在登出后会把 client.auth 置为 null，类型上显式容纳。
    readonly auth?: ConsoleClientAuth | null | undefined;
}

/**
 * 已登录客户端的本地权限复核（纵深防御）。
 *
 * 与 @koishijs/plugin-auth 的 `console/intercept` 判定一致：
 *  - 没有 auth（未启用鉴权插件或已登出）→ 放行：门槛交给控制台拦截器，本地不额外封锁；
 *  - 令牌过期或 authority 低于门槛 → 拒绝。
 * 正常路径由 intercept 先拒绝，本判定只覆盖拦截器缺失或被绕过的场景。
 */
export function passesLoginPanelAuthority(client: ConsoleAuthClient, now = Date.now()): boolean {
    const auth = client.auth;
    if (auth === undefined || auth === null) {
        return true;
    }
    if (auth.expiredAt <= now) {
        return false;
    }
    return auth.authority >= LOGIN_PANEL_AUTHORITY;
}

/** 无权限客户端拿到的脱敏快照：不含二维码、登录账号与错误详情。 */
export function redactLoginPanelPayload(selfId: string): LoginPanelPayload {
    return {
        state: "idle",
        selfId,
        message: "无权限查看登录状态（需要管理员权限）",
    };
}
