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
} from "../../../src/console/model.js";

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
                passesLoginPanelAuthority({ auth: { authority, expiredAt: FUTURE } }, true, PAST),
            ).toBe(false);
        }
    });

    it("管理员（3 级及以上）放行", () => {
        for (const authority of [3, 4, 5]) {
            expect(
                passesLoginPanelAuthority({ auth: { authority, expiredAt: FUTURE } }, true, PAST),
            ).toBe(true);
        }
    });

    it("令牌过期时一律拒绝，即使权限等级足够", () => {
        expect(
            passesLoginPanelAuthority({ auth: { authority: 5, expiredAt: 100 } }, true, 100),
        ).toBe(false);
    });

    it("Auth 启用时匿名及登出都拒绝，无 Auth 时允许访问", () => {
        for (const client of [{}, { auth: null }]) {
            expect(passesLoginPanelAuthority(client, true, PAST)).toBe(false);
            expect(passesLoginPanelAuthority(client, false, PAST)).toBe(true);
        }
    });

    it("拒绝无效的权限或截止时间", () => {
        expect(
            passesLoginPanelAuthority(
                {
                    auth: { authority: Number.NaN, expiredAt: FUTURE },
                },
                true,
                PAST,
            ),
        ).toBe(false);
        expect(
            passesLoginPanelAuthority(
                {
                    auth: { authority: 5, expiredAt: Infinity },
                },
                true,
                PAST,
            ),
        ).toBe(false);
    });
});

describe("redactLoginPanelPayload", () => {
    it("脱敏快照不含二维码、登录账号与错误详情", () => {
        const payload = redactLoginPanelPayload("10001");
        expect(payload).toEqual({
            state: "idle",
            selfId: "10001",
            generation: 0,
            message: "无权限查看登录状态（需要管理员权限）",
        });
        expect(payload.qrUrl).toBeUndefined();
        expect(payload.image).toBeUndefined();
        expect(payload.self).toBeUndefined();
        expect(payload.lastError).toBeUndefined();
    });
});
