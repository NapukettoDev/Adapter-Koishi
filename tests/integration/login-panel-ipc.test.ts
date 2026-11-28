import { describe, expect, it, vi } from "vitest";
import { IPC_VERSION } from "../../src/runtime/ipc/index.js";
import { BOT_STATUS } from "../../src/shared.js";
import { PNG_DATA_URI } from "../fixtures/png.js";
import {
    createConsole,
    latestChild,
    launch,
    RESTART_DELAY_MS,
    SELF_ID,
    selfInfo,
    setupPanel,
    startBot,
} from "./harness.js";

describe("控制台事件到子进程 IPC 的接线", () => {
    it("同账号顺序卸载后，重建服务、控制监听和连接回放", async () => {
        const shared = createConsole();
        const first = setupPanel(SELF_ID, shared);
        const stopping = first.dispose();
        expect(shared.services.size).toBe(0);
        expect(Object.keys(shared.listeners)).toHaveLength(0);
        expect(shared.connections.size).toBe(0);
        expect(shared.entries.size).toBe(0);
        await stopping;

        const current = setupPanel(SELF_ID, shared);
        const child = await startBot(current.bot);
        child.login({ state: "waiting_scan" });
        child.qr("https://current.example/qr", "bmV3");
        expect(current.provider).not.toBe(first.provider);
        expect(shared.connections.size).toBe(1);
        expect(shared.pushed).toEqual([]);
        const payload = { selfId: SELF_ID, qrUrl: "https://current.example/qr" };
        expect(await shared.connect()).toMatchObject([payload]);
        expect(shared.pushed).toMatchObject([payload]);
        current.click("refresh-qr");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "login.refreshQr" },
        });
    });

    it("同账号旧服务仍在注册表时，接管三个控制操作和新连接数据", async () => {
        const shared = createConsole();
        const old = setupPanel(SELF_ID, shared);
        const oldChild = await startBot(old.bot);
        oldChild.login({ state: "waiting_scan" });
        oldChild.qr("https://old.example/qr", "b2xk");

        // 宿主已退出，旧面板的作用域清理尚未执行。
        const stopping = old.bot.stop();
        oldChild.emit("exit", 0, null);
        await stopping;
        expect(shared.services.get(old.serviceName)).toBe(old.provider);

        const current = setupPanel(SELF_ID, shared);
        const child = await startBot(current.bot);
        child.login({ state: "waiting_scan" });
        child.qr("https://current.example/qr", "bmV3");
        expect(current.provider).toBe(old.provider);
        expect(Object.keys(shared.listeners)).toHaveLength(3);
        expect(shared.connections.size).toBe(1);

        const payload = { selfId: SELF_ID, qrUrl: "https://current.example/qr" };
        expect(await shared.connect()).toMatchObject([payload]);
        expect(shared.pushed).toMatchObject([payload]);
        current.click("relogin");
        current.click("qr-login");
        current.click("refresh-qr");
        expect(child.received).toMatchObject([
            { type: "control", payload: { command: "login", uin: SELF_ID, qr: false } },
            { type: "control", payload: { command: "login", uin: SELF_ID, qr: true } },
            { type: "action", payload: { action: "login.refreshQr" } },
        ]);
    });

    it("同账号实例重叠时，旧 Bot 的快照与晚到 dispose 不影响当前面板", async () => {
        const shared = createConsole();
        const old = setupPanel(SELF_ID, shared);
        const oldChild = await startBot(old.bot);
        const current = setupPanel(SELF_ID, shared);
        oldChild.login({ state: "waiting_scan" });
        oldChild.qr("https://old.example/qr", "b2xk");
        const admin = { auth: { authority: 3, expiredAt: 9_999_999_999_999 } };
        expect(await shared.connect(admin)).toMatchObject([{ selfId: SELF_ID, state: "idle" }]);
        expect(shared.pushed).toMatchObject([{ selfId: SELF_ID, state: "idle" }]);
        current.click("refresh-qr", admin);
        expect(oldChild.received).toEqual([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(current.logger.warn).toHaveBeenCalled();

        const stopping = old.bot.stop();
        oldChild.emit("exit", 0, null);
        await stopping;
        const child = await startBot(current.bot);
        child.login({ state: "waiting_scan" });
        child.qr("https://current.example/qr", "bmV3");
        await old.dispose();
        old.bot["panel"].push();
        expect(shared.entries.size).toBe(1);
        expect(shared.services.get(current.serviceName)).toBe(current.provider);
        expect(shared.connections.size).toBe(1);
        const payload = { selfId: SELF_ID, qrUrl: "https://current.example/qr" };
        expect(await shared.connect()).toMatchObject([payload]);
        expect(shared.pushed.at(-1)).toMatchObject(payload);
        current.click("refresh-qr", admin);
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "login.refreshQr" },
        });

        const stopCurrent = current.dispose();
        child.emit("exit", 0, null);
        await stopCurrent;
        expect(shared.services.size).toBe(0);
        expect(Object.keys(shared.listeners)).toHaveLength(0);
        expect(shared.connections.size).toBe(0);
        expect(shared.entries.size).toBe(0);
    });

    it("同一控制台的两个在线 Bot 共用入口，最后一个停用后释放，重新启用时恢复", async () => {
        const shared = createConsole();
        const first = setupPanel(SELF_ID, shared);
        const secondId = "10002";
        const second = setupPanel(secondId, shared);
        const firstChild = await startBot(first.bot);
        firstChild.ready();
        const secondChild = await startBot(second.bot);
        secondChild.ready(secondId);
        expect(first.bot.online).toHaveBeenCalledOnce();
        expect(second.bot.online).toHaveBeenCalledOnce();
        expect(shared.entries.size).toBe(1);
        expect(shared.addSharedEntry).toHaveBeenCalledOnce();
        expect(shared.connections.size).toBe(2);
        expect(Object.keys(shared.listeners)).toHaveLength(6);
        const firstPayload = { selfId: SELF_ID, state: "logged_in" };
        const secondPayload = { selfId: secondId, state: "logged_in" };
        expect(await shared.connect()).toMatchObject([firstPayload, secondPayload]);
        expect(shared.pushed).toMatchObject([firstPayload, secondPayload]);

        const stopFirst = first.dispose();
        expect(shared.entries.size).toBe(1);
        expect(shared.connections.size).toBe(1);
        expect(shared.services.has(first.serviceName)).toBe(false);
        expect(first.listener("refresh-qr")).toBeUndefined();
        expect(await shared.connect()).toMatchObject([secondPayload]);
        firstChild.emit("exit", 0, null);
        await stopFirst;
        second.click("refresh-qr");
        expect(secondChild.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "login.refreshQr" },
        });

        const stopSecond = second.dispose();
        expect(shared.entries.size).toBe(0);
        const enabledAgain = setupPanel(secondId, shared);
        const starting = enabledAgain.bot.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(shared.entries.size).toBe(1);
        expect(shared.addSharedEntry).toHaveBeenCalledTimes(2);
        secondChild.emit("exit", 0, null);
        await Promise.all([stopSecond, starting]);
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(3);
        latestChild().ready(secondId);
        expect(enabledAgain.bot.online).toHaveBeenCalledOnce();
        expect(shared.entries.size).toBe(1);
    });

    it("业务客户端尚未绑定时，可刷新二维码、重新登录和原地强制扫码", async () => {
        const { bot, click, logger } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        expect(bot["lifecycle"]["driver"]?.currentState).toBe("booting");
        expect(bot["lifecycle"]["driver"]?.currentClient).not.toBeNull();
        expect(bot["lifecycle"].client).toBeNull();
        await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");

        click("refresh-qr");
        click("relogin");
        click("qr-login");
        expect(
            child.received.map((message) => [
                message.type,
                "payload" in message ? message.payload : undefined,
            ]),
        ).toEqual([
            ["action", { action: "login.refreshQr" }],
            ["control", { command: "login", uin: SELF_ID, qr: false }],
            ["control", { command: "login", uin: SELF_ID, qr: true }],
        ]);
        await vi.advanceTimersByTimeAsync(0);
        expect(logger.info).toHaveBeenCalledWith("[napuketto] 刷新二维码: %s", "已触发新二维码");
        expect(bot["lifecycle"]["qrOnlyRef"].current).toBe(false);
    });

    it("failed 时通过仍在引导的连接重启，后续启动只消费一次扫码标记", async () => {
        const { bot, click } = setupPanel();
        const first = await startBot(bot);
        first.login({ state: "failed" });

        click("qr-login");
        expect(first.received).toEqual([
            { v: IPC_VERSION, type: "control", payload: { command: "restart" } },
        ]);
        first.emit("exit", 0, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        const second = latestChild();
        expect(second).not.toBe(first);
        expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ qrOnly: true }));

        second.emit("exit", 1, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS * 2);
        expect(launch).toHaveBeenCalledTimes(3);
        expect(launch.mock.lastCall?.[0]).not.toHaveProperty("qrOnly");
    });

    it.each(["relogin", "qr-login"] as const)(
        "在线时 %s 立即显示连接中，由新宿主接收扫码状态",
        async (action) => {
            const consoleHost = createConsole();
            const { bot, click } = setupPanel(SELF_ID, consoleHost);
            await consoleHost.connect();
            const first = await startBot(bot);
            first.ready();
            expect(bot.online).toHaveBeenCalledOnce();

            click(action);
            expect(first.received).toEqual([
                { v: IPC_VERSION, type: "control", payload: { command: "restart" } },
            ]);
            expect(bot.status).toBe(BOT_STATUS.CONNECT);
            await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");
            first.ready(); // 旧宿主在退出前迟到的 ready 不得恢复在线。
            await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
            expect(consoleHost.pushed.at(-1)).toMatchObject({ state: "idle" });
            expect(launch).toHaveBeenCalledOnce();
            expect(bot.online).toHaveBeenCalledOnce();

            first.emit("exit", 0, null);
            await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
            const second = latestChild();
            expect(second).not.toBe(first);
            expect(bot.status).toBe(BOT_STATUS.CONNECT);
            expect(launch.mock.lastCall?.[0]?.qrOnly ?? false).toBe(action === "qr-login");

            second.qr();
            second.login({ state: "waiting_scan" });
            await vi.advanceTimersByTimeAsync(0);
            expect(consoleHost.pushed.at(-1)).toMatchObject({
                state: "waiting_scan",
                image: PNG_DATA_URI,
            });
            second.login({ state: "scanned" });
            await vi.advanceTimersByTimeAsync(0);
            expect(consoleHost.pushed.at(-1)).toMatchObject({
                state: "scanned",
                message: "已扫码，请在手机上确认登录",
            });
            expect(bot.status).toBe(BOT_STATUS.CONNECT);

            second.ready();
            await vi.advanceTimersByTimeAsync(0);
            expect(consoleHost.pushed.at(-1)).toMatchObject({ state: "logged_in" });
            expect(bot.online).toHaveBeenCalledTimes(2);
            await bot.deleteMessage("private:20001", "1");
            expect(second.received.at(-1)).toMatchObject({
                type: "action",
                payload: { action: "msg.recallMessage" },
            });
        },
    );

    it("连接关闭后各入口反馈失败，扫码保留给下次启动", async () => {
        const { bot, click, logger } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        child.emit("close");

        click("refresh-qr");
        click("relogin");
        click("qr-login");
        await vi.advanceTimersByTimeAsync(0);
        expect(child.received).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(
            "[napuketto] 刷新二维码失败: %o",
            expect.objectContaining({
                code: "CLOSED",
                message: expect.stringContaining("子进程未就绪"),
            }),
        );
        expect(logger.warn).toHaveBeenCalledWith("[napuketto] 子进程未就绪，无法重新登录");
        expect(logger.warn).toHaveBeenCalledWith("[napuketto] 子进程未就绪，已标记下次启动时扫码");

        child.emit("exit", 1, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        expect(launch).toHaveBeenLastCalledWith(expect.objectContaining({ qrOnly: true }));
    });

    it("消息和业务动作等待 ready，重新扫码换账号后中止业务和面板连接", async () => {
        const { bot, click } = setupPanel();
        const child = await startBot(bot);
        child.receiveMessage("old", Date.now() - 60_000);
        child.receiveMessage();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).not.toHaveBeenCalled();

        child.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ messageId: "m1" }),
        );
        await bot.deleteMessage("private:20001", "1");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: { action: "msg.recallMessage" },
        });

        click("qr-login");
        child.emit("exit", 0, null);
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        const replacement = latestChild();
        replacement.login({ state: "logged_in", selfInfo: { ...selfInfo, uin: "20002" } });
        const sent = replacement.received.length;
        expect(replacement.received.at(-1)).toMatchObject({
            type: "control",
            payload: { command: "stop" },
        });

        await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");
        click("relogin");
        replacement.receiveMessage();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledTimes(1);
        expect(replacement.received).toHaveLength(sent);
    });
});
