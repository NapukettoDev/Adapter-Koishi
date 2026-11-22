/**
 * payload.test.ts：LoginSnapshot → LoginPanelPayload 纯函数映射单测。
 */
import { describe, expect, it } from "vitest";
import {
    loginStateMessage,
    sanitizeQrCodeUrl,
    toLoginPanelPayload,
} from "../../../src/console/model.js";

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
        const payload = toLoginPanelPayload({ state: "idle" }, "10001");
        expect(payload).toEqual({
            state: "idle",
            selfId: "10001",
            message: "未登录（等待子进程就绪）",
        });
        expect(payload.qr).toBeUndefined();
        expect(payload.self).toBeUndefined();
        expect(payload.lastError).toBeUndefined();
    });

    it("QR 条件展开（waiting_scan）", () => {
        const payload = toLoginPanelPayload(
            {
                state: "waiting_scan",
                qr: { pngBase64: "aGVsbG8=", qrcodeUrl: "https://example.com/qr" },
            },
            "10001",
        );
        expect(payload.qr).toEqual({ pngBase64: "aGVsbG8=", qrcodeUrl: "https://example.com/qr" });
        expect(payload.image).toBe("data:image/png;base64,aGVsbG8=");
        expect(payload.message).toBe("请使用手机 QQ 扫描二维码");
    });

    it("pngBase64 为空时不产出 image 字段", () => {
        const payload = toLoginPanelPayload(
            { state: "waiting_scan", qr: { pngBase64: "", qrcodeUrl: "https://example.com/qr" } },
            "10001",
        );
        expect(payload.qr).toBeDefined();
        expect(payload.image).toBeUndefined();
    });

    it("self 条件展开（logged_in）", () => {
        const payload = toLoginPanelPayload(
            { state: "logged_in", self: { uin: "10001", uid: "u_1", nick: "测试号" } },
            "10001",
        );
        expect(payload.self).toEqual({ uin: "10001", uid: "u_1", nick: "测试号" });
    });

    it("lastError 条件展开（failed）", () => {
        const payload = toLoginPanelPayload({ state: "failed", lastError: "登录失败" }, "10001");
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
        "",
        "  ",
    ])("丢弃非 http/https 或无法解析的值: %s", (url) => {
        expect(sanitizeQrCodeUrl(url)).toBeUndefined();
    });
});

describe("toLoginPanelPayload 二维码外链校验", () => {
    it("非法协议只移除外链，二维码图片仍保留", () => {
        const payload = toLoginPanelPayload(
            {
                state: "waiting_scan",
                qr: { pngBase64: "aGVsbG8=", qrcodeUrl: "javascript:alert(1)" },
            },
            "10001",
        );
        expect(payload.qr).toBeUndefined();
        expect(payload.image).toBe("data:image/png;base64,aGVsbG8=");
    });

    it("合法 https 外链保留并规范化", () => {
        const payload = toLoginPanelPayload(
            {
                state: "waiting_scan",
                qr: { pngBase64: "aGVsbG8=", qrcodeUrl: "HTTPS://Example.com/qr" },
            },
            "10001",
        );
        expect(payload.qr).toEqual({
            pngBase64: "aGVsbG8=",
            qrcodeUrl: "https://example.com/qr",
        });
        expect(payload.image).toBe("data:image/png;base64,aGVsbG8=");
    });
});
