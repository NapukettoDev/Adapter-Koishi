import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { ElementType } from "@napuketto/kernel";
import { launchSelfHost } from "@napuketto/loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRawMessage, mockH } from "../../events/test-utils.js";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    IPC_VERSION,
    type IpcMessage,
} from "../../ipc/index.js";
import { NapukettoBot } from "../bot.js";

vi.mock("koishi", () => {
    class Bot {
        ctx: unknown;
        config: unknown;
        logger: unknown;
        user = {};
        online = vi.fn();
        offline = vi.fn();
        toJSON = vi.fn();
        dispatch = vi.fn();
        session = (event: object) => ({ ...event });

        constructor(ctx: { logger: unknown }, config: unknown) {
            this.ctx = ctx;
            this.config = config;
            this.logger = ctx.logger;
        }
    }
    class MessageEncoder {}
    return {
        // biome-ignore lint/style/useNamingConvention: 与 Koishi 导出名一致
        Bot,
        // biome-ignore lint/style/useNamingConvention: 与 Koishi 导出名一致
        MessageEncoder,
        h: mockH(),
    };
});
vi.mock("@koishijs/plugin-console", () => {
    class DataService {
        async refresh(): Promise<void> {}
    }
    return {
        // biome-ignore lint/style/useNamingConvention: 与控制台导出名一致
        DataService,
    };
});
vi.mock("../../config.js", () => ({ napukettoConfigSchema: {} }));
vi.mock("../utils/console-entry.js", () => ({ registerConsoleEntry: vi.fn() }));
vi.mock("@napuketto/loader", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@napuketto/loader")>()),
    resolveQqInstall: vi.fn((qqPath: string) => ({
        qqPath,
        installDir: "test-qq",
        version: "9.9.33-51802",
        wrapperPath: "test-qq/wrapper.node",
        source: "local",
    })),
    launchSelfHost: vi.fn(),
}));

const SELF_ID = "10001";
const RESTART_DELAY_MS = 100;
const selfInfo = { uin: SELF_ID, uid: "u1", nick: "测试账号" };

class IpcChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = null;
    readonly received: IpcMessage[] = [];
    history: unknown[] = [];
    readonly stdin = new Writable({
        write: (chunk: Buffer, _encoding, done) => {
            const message = decodeIpcMessage(chunk.toString());
            if (message === null) {
                done(new Error("无效的 IPC 行"));
                return;
            }
            this.received.push(message);
            if (message.type === "action") {
                this.send({
                    v: IPC_VERSION,
                    type: "result",
                    id: message.id,
                    payload: {
                        ok: true,
                        value: message.payload.action === "msg.fetchMessages" ? this.history : true,
                    },
                });
            }
            done();
        },
    });
    readonly kill = vi.fn(() => true);

    send(message: IpcMessage): void {
        this.stdout.write(encodeIpcMessage(message));
    }

    login(payload: Extract<IpcMessage, { type: "login" }>["payload"]): void {
        this.send({ v: IPC_VERSION, type: "login", payload });
    }

    ready(): void {
        this.login({ state: "logged_in", selfInfo });
        this.send({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } });
    }

    receiveMessage(msgId = "m1", timestamp = Date.now()): void {
        this.send({
            v: IPC_VERSION,
            type: "event",
            payload: {
                service: "Msg",
                name: "onRecvMsg",
                args: [
                    [
                        {
                            msgId,
                            msgSeq: "1",
                            msgTime: String(timestamp),
                            msgType: 9,
                            chatType: 1,
                            peerUid: "u2",
                            peerUin: "20001",
                            senderUid: "u2",
                            senderUin: "20001",
                            elements: [{ elementType: 1, textElement: { content: "test" } }],
                        },
                    ],
                ],
            },
        });
    }
}

function setupPanel() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), level: 0 };
    const listeners = new Map<string, (data: { selfId: string }) => void>();
    const ctx = {
        config: { autoAssign: false, autoAuthorize: 0 },
        inject(_services: string[], setup: (fork: unknown) => void) {
            setup(this);
        },
        root: { get: vi.fn(), set: () => vi.fn() },
        console: {
            addListener: (name: string, listener: (data: { selfId: string }) => void) =>
                listeners.set(name, listener),
            ctx: { on: () => vi.fn() },
        },
        on: vi.fn(),
        logger,
    };
    const bot = new NapukettoBot(ctx as unknown as ConstructorParameters<typeof NapukettoBot>[0], {
        selfId: SELF_ID,
        qqPath: "test-qq/QQ.exe",
        restart: { backoffMs: RESTART_DELAY_MS },
    });
    return {
        bot,
        logger,
        click(action: "refresh-qr" | "relogin" | "qr-login") {
            const handler = listeners.get(`napuketto-login-${SELF_ID}/${action}`);
            if (handler === undefined) {
                throw new Error(`面板事件未注册: ${action}`);
            }
            handler({ selfId: SELF_ID });
        },
    };
}

const launch = vi.mocked(launchSelfHost);
let children: IpcChild[];

beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    launch.mockReset().mockImplementation(async () => {
        const child = new IpcChild();
        children.push(child);
        return { child: child as unknown as ChildProcess, bootJsPath: "test-qq/self-host.cjs" };
    });
});

afterEach(() => {
    for (const child of children) {
        child.emit("close");
    }
    vi.clearAllTimers();
    vi.useRealTimers();
});

async function startBot(bot: NapukettoBot): Promise<IpcChild> {
    await bot.start();
    await vi.advanceTimersByTimeAsync(0);
    return latestChild();
}

function latestChild(): IpcChild {
    const child = children.at(-1);
    if (child === undefined) {
        throw new Error("子进程未启动");
    }
    return child;
}

describe("控制台事件到子进程 IPC 的接线", () => {
    it("业务客户端尚未绑定时，可刷新二维码、重新登录和原地强制扫码", async () => {
        const { bot, click, logger } = setupPanel();
        const child = await startBot(bot);
        child.login({ state: "waiting_scan" });
        expect(bot["driver"]?.currentState).toBe("booting");
        expect(bot["driver"]?.currentClient).not.toBeNull();
        expect(bot["clientRef"].current).toBeNull();
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
        expect(bot["qrOnlyRef"].current).toBe(false);
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

    it("ready 后普通重登与扫码都走软重登，重启后切换到新连接", async () => {
        const { bot, click } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        expect(bot.online).toHaveBeenCalledOnce();

        click("relogin");
        click("qr-login");
        expect(
            first.received.map((message) => ("payload" in message ? message.payload : undefined)),
        ).toEqual([
            { command: "login", uin: SELF_ID, qr: false },
            { command: "login", uin: SELF_ID, qr: true },
        ]);

        first.emit("exit", 1, null);
        click("relogin");
        await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
        const second = latestChild();
        second.login({ state: "scanned" });
        click("refresh-qr");
        click("relogin");
        expect(
            second.received.map((message) => ("payload" in message ? message.payload : undefined)),
        ).toEqual([{ action: "login.refreshQr" }, { command: "login", uin: SELF_ID, qr: false }]);
        expect(first.received).toHaveLength(2);
        expect(launch.mock.lastCall?.[0]).not.toHaveProperty("qrOnly");
    });

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

    it("消息和业务动作等待 ready，软重登换账号后中止业务和面板连接", async () => {
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
        child.login({ state: "logged_in", selfInfo: { ...selfInfo, uin: "20002" } });
        const sent = child.received.length;
        expect(child.received.at(-1)).toMatchObject({
            type: "control",
            payload: { command: "stop" },
        });

        await expect(bot.deleteMessage("private:20001", "1")).rejects.toThrow("子进程未就绪");
        click("relogin");
        child.receiveMessage();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.dispatch).toHaveBeenCalledTimes(1);
        expect(child.received).toHaveLength(sent);
    });

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

    it("Bot 的历史查询透传分页参数并返回旧消息", async () => {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.history = [
            makeRawMessage({ msgId: "newer", msgTime: "1700000002" }),
            makeRawMessage({ msgId: "older", msgTime: "1700000001" }),
            makeRawMessage({ msgId: "oldest", msgTime: "1700000000" }),
        ];
        child.ready();

        const page = await bot.getMessageList("10001", "anchor", "before", 2, "desc");
        expect(child.received.at(-1)).toMatchObject({
            type: "action",
            payload: {
                action: "msg.fetchMessages",
                params: { chatType: 2, peerUin: "10001", count: 4, msgId: "anchor" },
            },
        });
        expect(page.data).toMatchObject([
            { id: "newer", content: "你好", createdAt: 1_700_000_002_000 },
            { id: "older", content: "你好", createdAt: 1_700_000_001_000 },
        ]);
        expect(page.next).toBe("older");
        expect(bot.dispatch).not.toHaveBeenCalled();
    });
});
