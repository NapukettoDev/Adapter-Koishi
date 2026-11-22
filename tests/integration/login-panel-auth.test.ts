import { describe, expect, it, vi } from "vitest";
import { SELF_ID, setupPanel, startBot, type TestConsoleClient } from "./harness.js";

describe("控制台登录面板鉴权", () => {
    const future = 9_999_999_999_999;
    const admin: TestConsoleClient = { auth: { authority: 5, expiredAt: future } };
    const viewer: TestConsoleClient = { auth: { authority: 2, expiredAt: future } };

    it("数据推送、连接拉取和三个控制事件共用管理员门槛", () => {
        const { provider, listener } = setupPanel();
        expect(provider?.options).toMatchObject({ immediate: true, authority: 3 });
        for (const action of ["relogin", "qr-login", "refresh-qr"] as const) {
            expect(listener(action)?.options).toEqual({ authority: 3 });
        }
    });

    it("低权限客户端拿不到二维码和账号信息，管理员可读取状态", async () => {
        const { bot, provider } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        child.qr("https://example.com/qr", "aGVsbG8=");
        await vi.advanceTimersByTimeAsync(0);

        const payload = await provider?.get(false, admin);
        expect(payload).toMatchObject({
            state: "waiting_scan",
            qr: { pngBase64: "aGVsbG8=", qrcodeUrl: "https://example.com/qr" },
            image: "data:image/png;base64,aGVsbG8=",
        });

        const denied = await provider?.get(false, viewer);
        expect(denied).toEqual({
            state: "idle",
            selfId: SELF_ID,
            message: "无权限查看登录状态（需要管理员权限）",
        });
        expect(denied?.qr).toBeUndefined();
        expect(denied?.image).toBeUndefined();
        expect(denied?.self).toBeUndefined();
    });

    it("低权限客户端不能触发登录控制，管理员仍可执行登录操作", async () => {
        const { bot, click } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        const sent = child.received.length;

        click("refresh-qr", viewer);
        click("relogin", viewer);
        click("qr-login", viewer);
        await vi.advanceTimersByTimeAsync(0);
        expect(child.received).toHaveLength(sent);

        click("refresh-qr", admin);
        click("relogin", admin);
        click("qr-login", admin);
        await vi.advanceTimersByTimeAsync(0);
        expect(
            child.received
                .slice(sent)
                .map((message) => [
                    message.type,
                    "payload" in message ? message.payload : undefined,
                ]),
        ).toEqual([
            ["action", { action: "login.refreshQr" }],
            ["control", { command: "login", uin: SELF_ID, qr: false }],
            ["control", { command: "login", uin: SELF_ID, qr: true }],
        ]);
    });

    it("未启用鉴权插件（无 auth）时保持读取和登录操作可用", async () => {
        const { bot, click, provider } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        await vi.advanceTimersByTimeAsync(0);

        const payload = await provider?.get(false, {});
        expect(payload?.state).toBe("waiting_scan");

        click("refresh-qr", {});
        await vi.advanceTimersByTimeAsync(0);
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "login.refreshQr" },
        });
    });
});
