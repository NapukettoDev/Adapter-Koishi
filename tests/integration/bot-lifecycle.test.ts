import { ElementType } from "@napuketto/kernel";
import { describe, expect, it, vi } from "vitest";
import type { DriverEvents } from "../../src/runtime/driver/types.js";
import { IPC_VERSION } from "../../src/runtime/ipc/index.js";
import { BOT_STATUS } from "../../src/shared.js";
import { makeRawMessage } from "../helpers/events.js";
import {
    createConsole,
    Logger,
    latestChild,
    launch,
    logRecords,
    SELF_ID,
    selfInfo,
    setupPanel,
    startBot,
} from "./harness.js";

describe("Bot 启停生命周期", () => {
    it("同一对象正常 stop 后再次 start，使用新 driver 并重新上线", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledOnce();
        expect(bot["lifecycle"]["driver"]?.currentState).toBe("ready");

        const stopping = bot.stop();
        first.emit("exit", 0, null);
        await stopping;
        expect(bot["lifecycle"]["driver"]).toBeNull();

        const second = await startBot(bot);
        expect(second).not.toBe(first);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(bot["lifecycle"]["identityMismatch"]).toBe(false);
        second.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledTimes(2);
        expect(bot.status).toBe(1);
    });

    it("错误账号拒绝上线后，再次 start 恢复正确账号", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready("20002");
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).not.toHaveBeenCalled();
        expect(bot["lifecycle"]["identityMismatch"]).toBe(true);
        expect(bot.status).toBe(0);

        // 账号校验已同步停 driver；此时再次 start 要等旧宿主确认退出。
        const restarting = bot.start();
        first.emit("exit", 0, null);
        await restarting;
        await vi.advanceTimersByTimeAsync(0);

        const second = latestChild();
        expect(second).not.toBe(first);
        expect(bot["lifecycle"]["identityMismatch"]).toBe(false);
        second.ready(SELF_ID);
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledOnce();
        expect(bot["lifecycle"].client).not.toBeNull();
    });

    it("软重登装配期间不派发事件，身份重新校验后才恢复在线", async () => {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledOnce();

        child.send({ v: IPC_VERSION, type: "status", payload: { phase: "sessioning" } });
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.status).toBe(BOT_STATUS.CONNECT);
        expect(bot["lifecycle"].client).toBeNull();
        expect(bot["lifecycle"].dispatchClient).toBeNull();

        child.receiveMessage("during-relogin");
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).not.toHaveBeenCalled();
        await expect(
            bot.internal.sendMessage("private:20001", [{ type: "text", attrs: { content: "x" } }]),
        ).rejects.toThrow("未就绪");

        child.login({ state: "logged_in", selfInfo });
        child.send({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } });
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledTimes(2);
        expect(bot["lifecycle"].client).not.toBeNull();

        child.receiveMessage("after-relogin");
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledOnce();
        expect(bot.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ messageId: "after-relogin" }),
        );
    });

    it("重复 start 只创建一个宿主，重复 stop 只停止一次", async () => {
        const { bot } = setupPanel();
        await Promise.all([bot.start(), bot.start()]);
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(1);

        const child = latestChild();
        const firstStop = bot.stop();
        const secondStop = bot.stop();
        child.emit("exit", 0, null);
        await Promise.all([firstStop, secondStop]);
        expect(bot.status).toBe(0);
        expect(bot["lifecycle"]["driver"]).toBeNull();
    });

    it("旧宿主退出造成短暂离线时，重叠 start 只创建一个新宿主", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);

        // 驱动仍在终止旧宿主时 Bot 已 offline：两个 start 可能同时看到非 active。
        first.emit("error", new Error("宿主崩溃"));
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.status).toBe(0);

        const starting = bot.start();
        first.emit("exit", 1, null);
        const overlapping = bot.start();
        await Promise.all([starting, overlapping]);
        await vi.advanceTimersByTimeAsync(0);

        expect(launch).toHaveBeenCalledTimes(2);
        const second = latestChild();
        second.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.status).toBe(1);
        expect(bot.online).toHaveBeenCalledTimes(2);
    });

    it("stop 与 start 重叠时等待旧宿主退出，新一轮正常上线", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);

        const stopping = bot.stop();
        const starting = bot.start();
        expect(bot.status).toBe(BOT_STATUS.CONNECT);
        first.emit("exit", 0, null);
        await Promise.all([stopping, starting]);
        await vi.advanceTimersByTimeAsync(0);

        expect(launch).toHaveBeenCalledTimes(2);
        const second = latestChild();
        expect(second).not.toBe(first);
        second.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledTimes(2);
        expect(bot.status).toBe(1);
    });

    it("启动尚未完成时 stop 会等待子进程退出，不留半启动状态", async () => {
        const { bot } = setupPanel();
        const starting = bot.start();
        const stopping = bot.stop();
        await vi.advanceTimersByTimeAsync(0);
        expect(launch).toHaveBeenCalledTimes(1);

        latestChild().emit("exit", null, "SIGTERM");
        await Promise.all([starting, stopping]);
        expect(bot.status).toBe(0);
        expect(bot["lifecycle"]["driver"]).toBeNull();
    });

    it("停止超时仍上报 EXIT_TIMEOUT，旧宿主退出后可再次 start", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);

        const stopping = bot.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(first.kill).toHaveBeenCalledWith("SIGTERM");
        expect(first.kill).toHaveBeenCalledWith("SIGKILL");
        expect(bot.status).toBe(0);
        expect(bot.error).toMatchObject({ code: "EXIT_TIMEOUT" });

        // 强制终止仍未确认退出时账号目录保持占用；迟到退出释放后才允许新一轮。
        first.emit("exit", null, "SIGKILL");
        await vi.advanceTimersByTimeAsync(0);
        const second = await startBot(bot);
        expect(second).not.toBe(first);
        second.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.status).toBe(1);
    });

    it("旧 driver 的迟到回调不会改写新一轮状态", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);
        const oldDriver = bot["lifecycle"]["driver"];
        if (oldDriver === null) {
            throw new Error("旧 driver 未创建");
        }

        const stopping = bot.stop();
        first.emit("exit", 0, null);
        await stopping;

        const second = await startBot(bot);
        second.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledTimes(2);

        const lateEvents = (oldDriver as unknown as { events: DriverEvents }).events;
        lateEvents.onExit?.({ code: 1, signal: null, reason: "crash" });
        lateEvents.onError?.(new Error("旧 driver 的迟到错误"));
        lateEvents.onReady?.();
        lateEvents.onLogin?.({
            state: "logged_in",
            selfInfo: { uin: "20002", uid: "u2", nick: "迟到账号" },
        });
        lateEvents.onQr?.({ pngBase64: "aGk=", qrcodeUrl: "https://late.example" });
        await vi.advanceTimersByTimeAsync(0);

        expect(bot.status).toBe(1);
        expect(bot.online).toHaveBeenCalledTimes(2);
        expect(bot["lifecycle"].client).not.toBeNull();
        expect(bot["login"].snapshot.self?.uin).toBe(SELF_ID);
        expect(bot["login"].snapshot.qr).toBeUndefined();
    });
    it("省略日志等级时使用 info", () => {
        setupPanel();
        expect(new Logger(`onebot-${SELF_ID}`).level).toBe(Logger.INFO);
    });

    it.each([
        ["debug", SELF_ID, "debug", "10002", "silent"],
        ["silent", "10002", "silent", SELF_ID, "debug"],
    ] as const)(
        "先启动 %s 时，两个账号的日志等级仍独立",
        async (_, firstId, firstLevel, secondId, secondLevel) => {
            const shared = createConsole();
            const first = setupPanel(firstId, shared, firstLevel);
            const firstChild = await startBot(first.bot);
            const second = setupPanel(secondId, shared, secondLevel);
            const secondChild = await startBot(second.bot);
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response(null, { status: 404 })),
            );

            for (const [account, child, selfId] of [
                [first, firstChild, firstId],
                [second, secondChild, secondId],
            ] as const) {
                child.qr("https://example.com/qr?ticket=qr-ticket", "cWgtc2VjcmV0");
                child.ready(selfId);
                child.send({
                    v: IPC_VERSION,
                    type: "log",
                    payload: { level: "info", message: "宿主就绪" },
                });
                child.receiveMessage();
                await vi.advanceTimersByTimeAsync(0);
                expect(account.bot.dispatch).toHaveBeenCalledOnce();
                expect(
                    await account.provider?.get(false, {
                        auth: { authority: 2, expiredAt: Date.now() + 60_000 },
                    }),
                ).toMatchObject({ selfId, state: "idle" });
                await account.bot.internal.sendMessage("private:20001", [
                    {
                        type: "img",
                        attrs: { src: "https://example.com/image.png?token=media-token" },
                    },
                ]);
            }

            expect(new Logger("onebot").level).toBe(Logger.ERROR);
            const botLogs = logRecords.filter(({ name }) => name.startsWith("onebot"));
            expect(new Set(botLogs.map(({ name }) => name))).toEqual(
                new Set([`onebot-${SELF_ID}`]),
            );
            expect(botLogs.map(({ type, content }) => `${type}: ${content}`)).toEqual(
                expect.arrayContaining([
                    "debug: [napuketto] 二维码更新",
                    "debug: [napuketto] 引导阶段: ready",
                    "debug: [napuketto 子进程] 宿主就绪",
                    "debug: [napuketto] 控制台客户端权限不足，返回脱敏登录快照",
                    expect.stringContaining("info: [napuketto] dispatch:"),
                    expect.stringContaining("warn: [napuketto] 远程媒体下载失败"),
                ]),
            );
            expect(logRecords.map(({ content }) => content).join("\n")).not.toMatch(
                /qr-ticket|cWgtc2VjcmV0|media-token/,
            );
        },
    );

    it.each([new Map([[0, "thumb.jpg"]]), { "0": "thumb.jpg" }])(
        "IPC JSON 往返后，含视频的整条消息仍会在 ready 后派发",
        async (thumbPath) => {
            const { bot } = setupPanel();
            const child = await startBot(bot);
            const raw = makeRawMessage({
                msgId: "with-video",
                msgTime: String(Date.now()),
                elements: [
                    { elementType: ElementType.TEXT, textElement: { content: "前缀" } },
                    {
                        elementType: ElementType.VIDEO,
                        videoElement: { filePath: "video.mp4", thumbPath },
                    },
                    { elementType: ElementType.TEXT, textElement: { content: "后缀" } },
                ],
            });
            child.send({
                v: IPC_VERSION,
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [[raw]] },
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(bot.dispatch).not.toHaveBeenCalled();

            child.ready();
            await vi.advanceTimersByTimeAsync(0);

            expect(bot.dispatch).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    messageId: "with-video",
                    elements: ["前缀", "[video]", "后缀"].map((content) =>
                        expect.objectContaining({ type: "text", attrs: { content } }),
                    ),
                }),
            );
        },
    );
});
