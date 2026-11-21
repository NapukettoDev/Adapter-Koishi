/**
 * payload.ts：LoginSnapshot → LoginPanelPayload 纯函数映射（docs/internals/console.md）。
 *
 * 独立成纯函数（不 import koishi 运行时）→ 可单测（docs/guides/development.md 单测边界）。
 */
import type { LoginState } from "@napuketto/kernel";
import type { LoginSnapshot } from "../login/types.js";
import type { LoginPanelPayload } from "./types.js";

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
