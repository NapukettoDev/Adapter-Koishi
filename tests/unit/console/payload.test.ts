/**
 * payload.test.ts：LoginSnapshot → LoginPanelPayload 纯函数映射单测。
 */
import { describe, expect, it } from "vitest";
import {
    loginStateMessage,
    sanitizeQrCodeUrl,
    toLoginPanelPayload,
} from "../../../src/console/model.js";
import { PNG_BASE64, PNG_DATA_URI } from "../../fixtures/png.js";

describe("loginStateMessage", () => {
    it("各状态映射人类可读文案", () => {
        expect(loginStateMessage("idle")).toBe("未登录（等待子进程就绪）");
        expect(loginStateMessage("waiting_scan")).toBe("请使用手机 QQ 扫描二维码");
        expect(loginStateMessage("scanned")).toBe("已扫码，请在手机上确认登录");
        expect(loginStateMessage("logged_in")).toBe("登录成功");
        expect(loginStateMessage("failed")).toBe("登录失败");
    });
});

describe("toLoginPanelPayload", () => {
    it("基础快照 → payload（state/selfId/message，无可选字段）", () => {
        const payload = toLoginPanelPayload({ state: "idle", generation: 0 }, "10001");
        expect(payload).toEqual({
            state: "idle",
            selfId: "10001",
            generation: 0,
            message: "未登录（等待子进程就绪）",
        });
        expect(payload.qrUrl).toBeUndefined();
        expect(payload.self).toBeUndefined();
        expect(payload.lastError).toBeUndefined();
    });

    it("同一二维码快照只交付一份 PNG 编码和独立外链", () => {
        const snapshot = {
            state: "waiting_scan",
            generation: 0,
            qr: { pngBase64: PNG_BASE64, qrcodeUrl: "HTTPS://Example.com/qr", expiresAt: 100 },
        } as const;
        const payload = toLoginPanelPayload(snapshot, "10001", 5);
        expect(payload).toEqual({
            state: "waiting_scan",
            selfId: "10001",
            generation: 0,
            qrExpiresAt: 100,
            qrUrl: "https://example.com/qr",
            image: PNG_DATA_URI,
            message: "请使用手机 QQ 扫描二维码",
        });
        expect(toLoginPanelPayload(snapshot, "10001", 100)).toEqual({
            state: "waiting_scan",
            selfId: "10001",
            generation: 0,
            qrExpiresAt: 100,
            message: "请使用手机 QQ 扫描二维码",
        });
    });

    it("非法 PNG 不影响合法外链", () => {
        const snapshot = {
            state: "waiting_scan",
            generation: 0,
            qr: { pngBase64: "aGVsbG8=", qrcodeUrl: "https://example.com/qr", expiresAt: 100 },
        } as const;
        const payload = toLoginPanelPayload(snapshot, "10001", 5);
        expect(payload.qrUrl).toBe("https://example.com/qr");
        expect(payload.image).toBeUndefined();
    });

    it("self 条件展开（logged_in）", () => {
        const payload = toLoginPanelPayload(
            {
                state: "logged_in",
                generation: 0,
                self: { uin: "10001", uid: "u_1", nick: "测试号" },
            },
            "10001",
        );
        expect(payload.self).toEqual({ uin: "10001", uid: "u_1", nick: "测试号" });
    });

    it("lastError 条件展开（failed）", () => {
        const payload = toLoginPanelPayload(
            { state: "failed", generation: 0, lastError: "登录失败" },
            "10001",
        );
        expect(payload.lastError).toBe("登录失败");
    });
});

describe("sanitizeQrCodeUrl", () => {
    it.each([
        "https://ssl.ptlogin2.qq.com/qr?u=abc",
        "http://example.com/login",
        "HTTPS://Example.com/QR",
    ])("保留 http/https 外链: %s", (url) => {
        expect(sanitizeQrCodeUrl(url)).toBe(new URL(url).href);
    });

    it.each([
        "javascript:alert(document.cookie)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "file:///C:/Windows/System32",
        "not a url",
        "https://user:pass@example.com/qr",
        "",
        "  ",
    ])("丢弃非 http/https 或无法解析的值: %s", (url) => {
        expect(sanitizeQrCodeUrl(url)).toBeUndefined();
    });
});

it("非法外链只移除链接，二维码图片仍保留", () => {
    const payload = toLoginPanelPayload(
        {
            state: "waiting_scan",
            generation: 0,
            qr: { pngBase64: PNG_BASE64, qrcodeUrl: "javascript:alert(1)", expiresAt: 100 },
        },
        "10001",
        5,
    );
    expect(payload.qrUrl).toBeUndefined();
    expect(payload.image).toBe(PNG_DATA_URI);
});

it("忽略与配置账号不符的登录身份", () => {
    const payload = toLoginPanelPayload(
        {
            state: "logged_in",
            generation: 0,
            self: { uin: "10002", uid: "u_2", nick: "其他账号" },
        },
        "10001",
    );
    expect(payload.self).toBeUndefined();
});
