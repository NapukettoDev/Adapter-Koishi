import type { LoginState, QrCodeData, SelfInfo } from "@napuketto/kernel";
import type { LoginSnapshot } from "./login-state.js";

/**
 * 控制台登录面板 payload。前端从 store['napuketto-login-<uin>'] 读取。
 */
export interface LoginPanelPayload {
    /** kernel 登录状态（idle/waiting_scan/scanned/logged_in/failed）。 */
    state: LoginState;
    /** 登录账号（QQ 号）——多账号隔离：serviceId 后缀 + 前端校验。 */
    selfId: string;
    /** 人类可读状态文案（面板主提示）。 */
    message?: string;
    /** 二维码完整 data URI（waiting_scan 时推送；前端直接 <img :src> 展示）。 */
    image?: string;
    /** 二维码（waiting_scan 时推送；pngBase64 + qrcodeUrl 链接兜底）。 */
    qr?: QrCodeData;
    /** 登录成功 selfInfo（logged_in 时）。 */
    self?: SelfInfo;
    /** 最近错误（failed 时）。 */
    lastError?: string;
}

/** 登录状态 → 面板人类可读文案。 */
export function loginStateMessage(state: LoginState): string {
    switch (state) {
        case "idle":
            return "未登录（等待子进程就绪）";
        case "waiting_scan":
            return "请使用手机 QQ 扫描二维码";
        case "scanned":
            return "已扫码，请在手机上确认登录";
        case "logged_in":
            return "登录成功";
        case "failed":
            return "登录失败";
    }
}

/** 二维码外链允许的协议（只放行 http/https；javascript:/data:/file: 等一律丢弃）。 */
const ALLOWED_QR_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * 校验二维码登录链接的协议。
 *
 * qrcodeUrl 来自子进程（kernel），前端会把它交给 window.open——不校验协议时
 * `javascript:` 等 URL 能在新窗口执行脚本。合法值返回规范化 URL，非法返回 undefined。
 */
export function sanitizeQrCodeUrl(value: string): string | undefined {
    if (value.trim() === "") {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    return ALLOWED_QR_URL_PROTOCOLS.has(url.protocol) ? url.href : undefined;
}

/** LoginSnapshot → LoginPanelPayload（exactOptionalPropertyTypes：条件展开，不显式赋 undefined）。 */
export function toLoginPanelPayload(snapshot: LoginSnapshot, selfId: string): LoginPanelPayload {
    const qr = snapshot.qr;
    const qrUrl = qr === undefined ? undefined : sanitizeQrCodeUrl(qr.qrcodeUrl);
    return {
        state: snapshot.state,
        selfId,
        message: loginStateMessage(snapshot.state),
        // 外链协议不合法时只丢掉 qr（前端隐藏“打开登录链接”），二维码图片照常展示。
        ...(qr !== undefined && qrUrl !== undefined ? { qr: { ...qr, qrcodeUrl: qrUrl } } : {}),
        // 二维码完整 data URI（前端 <img> 直接展示，参照 bilibili-dm 的 image 字段）
        ...(qr !== undefined && qr.pngBase64 !== ""
            ? { image: `data:image/png;base64,${qr.pngBase64}` }
            : {}),
        ...(snapshot.self !== undefined ? { self: snapshot.self } : {}),
        ...(snapshot.lastError !== undefined ? { lastError: snapshot.lastError } : {}),
    };
}

/** 登录数据推送、连接时拉取和控制事件共用管理员权限等级。 */
export const LOGIN_PANEL_AUTHORITY = 3;

/** DataService / addListener 的鉴权选项。 */
interface LoginPanelAccessOptions {
    authority: number;
}

/** 构造鉴权选项（每次返回新对象，避免调用方共享可变状态）。 */
export function loginPanelAccessOptions(): LoginPanelAccessOptions {
    return { authority: LOGIN_PANEL_AUTHORITY };
}

/** @koishijs/plugin-auth 注入到控制台客户端上的登录态（只取判定需要的字段）。 */
interface ConsoleClientAuth {
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
