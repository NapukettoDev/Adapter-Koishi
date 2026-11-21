/**
 * access.test.ts：控制台登录面板鉴权门槛单测（与 @koishijs/plugin-auth 的
 * console/intercept 契约对齐，不加载 koishi 运行时）。
 */
import { describe, expect, it } from "vitest";
import {
    LOGIN_PANEL_AUTHORITY,
    loginPanelAccessOptions,
    passesLoginPanelAuthority,
    redactLoginPanelPayload,
} from "../access.js";

const FUTURE = 1_000_000;
const PAST = 0;

describe("loginPanelAccessOptions", () => {
    it("推送、连接拉取与三个控制事件共用的管理员门槛为 3", () => {
        expect(LOGIN_PANEL_AUTHORITY).toBe(3);
        expect(loginPanelAccessOptions()).toEqual({ authority: LOGIN_PANEL_AUTHORITY });
    });

    it("每次返回独立对象，避免调用方互相污染", () => {
        const first = loginPanelAccessOptions();
        const second = loginPanelAccessOptions();
        expect(first).not.toBe(second);
        first.authority = 0;
        expect(second.authority).toBe(LOGIN_PANEL_AUTHORITY);
    });
});

describe("passesLoginPanelAuthority", () => {
    it("低权限已登录客户端被拒绝（含权限等级 0-2）", () => {
        for (const authority of [0, 1, 2]) {
            expect(
                passesLoginPanelAuthority({ auth: { authority, expiredAt: FUTURE } }, PAST),
            ).toBe(false);
        }
    });

    it("管理员（3 级及以上）放行", () => {
        for (const authority of [3, 4, 5]) {
            expect(
                passesLoginPanelAuthority({ auth: { authority, expiredAt: FUTURE } }, PAST),
            ).toBe(true);
        }
    });

    it("令牌过期时一律拒绝，即使权限等级足够", () => {
        expect(passesLoginPanelAuthority({ auth: { authority: 5, expiredAt: 100 } }, 100)).toBe(
            false,
        );
    });

    it("没有 auth 或已登出（auth=null）时放行：门槛由控制台拦截器决定", () => {
        expect(passesLoginPanelAuthority({}, PAST)).toBe(true);
        expect(passesLoginPanelAuthority({ auth: null }, PAST)).toBe(true);
    });
});

describe("redactLoginPanelPayload", () => {
    it("脱敏快照不含二维码、登录账号与错误详情", () => {
        const payload = redactLoginPanelPayload("10001");
        expect(payload).toEqual({
            state: "idle",
            selfId: "10001",
            message: "无权限查看登录状态（需要管理员权限）",
        });
        expect(payload.qr).toBeUndefined();
        expect(payload.image).toBeUndefined();
        expect(payload.self).toBeUndefined();
        expect(payload.lastError).toBeUndefined();
    });
});
