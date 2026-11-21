import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { ElementType } from "@napuketto/kernel";
import { launchSelfHost } from "@napuketto/loader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogLevel } from "../../config.js";
import type { LoginPanelPayload } from "../../console/types.js";
import { BOT_STATUS } from "../../constants.js";
import type { DriverEvents } from "../../driver/types.js";
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
        /** 与 satorijs Status 对齐：OFFLINE=0 / ONLINE=1 / CONNECT=2 / DISCONNECT=3。 */
        status = 0;
        error: unknown;
        get isActive(): boolean {
            return this.status !== 0 && this.status !== 3;
        }
        online = vi.fn(() => {
            this.status = 1;
            this.error = undefined;
        });
        offline = vi.fn((error?: Error) => {
            this.status = 0;
            this.error = error;
        });
        async stop(): Promise<void> {
            if (!this.isActive) {
                return;
            }
            this.status = 3;
            this.status = 0;
        }
        toJSON = vi.fn();
        dispatch = vi.fn();
        session = (event: object) => ({ ...event });

        constructor(ctx: { logger(name: string): unknown }, config: unknown, adapterName: string) {
            this.ctx = ctx;
            this.config = config;
            this.logger = ctx.logger(adapterName);
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
        options: { authority?: number; immediate?: boolean } | undefined;

        constructor(
            private readonly ctx: { console: { broadcast: TestBroadcast } },
            private readonly key: string,
            options?: { authority?: number; immediate?: boolean },
        ) {
            this.options = options;
        }

        async get(_forced: boolean, _client: TestConsoleClient): Promise<LoginPanelPayload> {
            throw new Error("mock DataService 需要子类实现 get()");
        }

        async refresh(): Promise<void> {
            await this.ctx.console.broadcast(this.key, (client) => this.get(true, client));
        }
    }
    return {
        // biome-ignore lint/style/useNamingConvention: 与控制台导出名一致
        DataService,
    };
});
vi.mock("../../config.js", () => ({ napukettoConfigSchema: {} }));
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

// 复用 Satori 的实际 Logger，实现名称共享等级的回归测试，同时保持 Koishi 运行时为 mock。
const requireKoishi = createRequire(import.meta.resolve("koishi"));
const requireSatori = createRequire(requireKoishi.resolve("@satorijs/core"));
const { Logger } = requireSatori("cordis") as Pick<typeof import("koishi"), "Logger">;
const originalLogLevels = Logger.levels;
const originalLogTargets = Logger.targets;

class IpcChild extends EventEmitter {
    readonly pid = 1000;
    readonly stdout = new PassThrough();
    readonly stderr = null;
    readonly received: IpcMessage[] = [];
    readonly actionResponses = new Map<string, unknown>();
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
                const action = message.payload.action;
                this.send({
                    v: IPC_VERSION,
                    type: "result",
                    id: message.id,
                    payload: {
                        ok: true,
                        value:
                            this.actionResponses.get(action) ??
                            (action === "msg.fetchMessages" ? this.history : true),
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

    ready(uin = SELF_ID): void {
        this.login({ state: "logged_in", selfInfo: { ...selfInfo, uin } });
        this.send({ v: IPC_VERSION, type: "status", payload: { phase: "ready" } });
    }

    qr(qrcodeUrl = "https://example.com/qr", pngBase64 = "aGVsbG8="): void {
        this.send({ v: IPC_VERSION, type: "qr", payload: { pngBase64, qrcodeUrl } });
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

type TestBroadcast = (
    key: string,
    get: (client: TestConsoleClient) => Promise<LoginPanelPayload>,
) => Promise<void>;

function createConsole() {
    const entries = new Set<object>();
    const services = new Map<string, TestLoginProvider>();
    const listeners: Record<string, TestConsoleListener> = {};
    const connections = new Set<() => void>();
    const clients = new Set<TestConsoleClient>();
    const pushed: LoginPanelPayload[] = [];
    const broadcast: TestBroadcast = async (_key, get) => {
        await Promise.all(
            Array.from(clients, async (client) => {
                pushed.push(await get(client));
            }),
        );
    };
    const addEntry = (effects: Set<() => void>) => {
        const entry = {
            dispose() {
                entries.delete(entry);
                effects.delete(entry.dispose);
            },
        };
        entries.add(entry);
        effects.add(entry.dispose);
        return entry;
    };
    const addSharedEntry = vi.fn(addEntry);
    function createScope(effects: Set<() => void>) {
        const on = (event: string, callback: () => void) => {
            if (event === "dispose") {
                effects.add(callback);
                return () => effects.delete(callback);
            }
            expect(event).toBe("console/connection");
            connections.add(callback);
            const off = () => {
                connections.delete(callback);
                effects.delete(off);
            };
            effects.add(off);
            return off;
        };
        return {
            on,
            console: {
                entries,
                listeners,
                broadcast,
                ctx: { on },
                addEntry: () => addSharedEntry(effects),
                addListener: (
                    name: string,
                    callback: TestConsoleListener["callback"],
                    options?: TestConsoleListener["options"],
                ) => {
                    // Console 的监听器表共享，注册本身不会创建作用域清理。
                    listeners[name] = { callback, options };
                },
            },
        };
    }
    const root = {
        inject(_services: string[], setup: (owner: unknown) => void) {
            const effects = new Set<() => void>();
            setup({ ...createScope(effects), set: this.set.bind(this, effects) });
            return {
                dispose() {
                    for (const dispose of effects) {
                        dispose();
                    }
                    effects.clear();
                },
            };
        },
        get: (name: string) => services.get(name),
        set: (effects: Set<() => void>, name: string, value: TestLoginProvider) => {
            if (services.has(name)) {
                throw new Error(`service ${name} has been registered`);
            }
            services.set(name, value);
            const dispose = () => {
                services.delete(name);
                effects.delete(dispose);
            };
            effects.add(dispose);
            return dispose;
        },
    };
    return {
        root: {
            ...root,
            set: root.set.bind(root, new Set()),
            inject: root.inject.bind(root),
        },
        entries,
        services,
        listeners,
        connections,
        pushed,
        createScope,
        addSharedEntry,
        connect(client: TestConsoleClient = {}) {
            // Client.refresh() 发起拉取后，Console.accept() 再登记客户端并发出连接事件。
            const pulled = Promise.all(
                Array.from(services.values(), (provider) => provider.get(false, client)),
            );
            clients.add(client);
            for (const replay of connections) {
                replay();
            }
            return pulled;
        },
    };
}

/** 集成测试侧的最小 client 形状：auth 由 @koishijs/plugin-auth 注入。 */
interface TestConsoleClient {
    auth?: { authority: number; expiredAt: number };
}

/** 断言用 provider 形状（真实实例由 bot 构造，运行时经 mock DataService）。 */
interface TestLoginProvider {
    readonly options: { authority?: number; immediate?: boolean } | undefined;
    get(forced?: boolean, client?: TestConsoleClient): Promise<LoginPanelPayload>;
}

interface TestConsoleListener {
    readonly callback: (this: TestConsoleClient, data: { selfId: string }) => void;
    readonly options: { authority?: number } | undefined;
}

function setupPanel(selfId = SELF_ID, consoleHost = createConsole(), logLevel?: LogLevel) {
    const effects = new Set<() => void>();
    const ctx = {
        ...consoleHost.createScope(effects),
        baseDir,
        config: { autoAssign: false, autoAuthorize: 0 },
        inject(_services: string[], setup: (fork: unknown) => void) {
            setup(this);
        },
        root: consoleHost.root,
        logger: Object.assign((name: string) => new Logger(name), {
            info: new Logger("napuketto").info,
        }),
    };
    const bot = new NapukettoBot(ctx as unknown as ConstructorParameters<typeof NapukettoBot>[0], {
        selfId,
        qqPath: "test-qq/QQ.exe",
        restart: { backoffMs: RESTART_DELAY_MS },
        ...(logLevel === undefined ? {} : { logLevel }),
    });
    vi.spyOn(bot.logger, "info");
    vi.spyOn(bot.logger, "warn");
    const serviceName = `console.services.napuketto-login-${selfId}`;
    return {
        bot,
        logger: bot.logger,
        serviceName,
        provider: consoleHost.services.get(serviceName),
        listener(action: "refresh-qr" | "relogin" | "qr-login"): TestConsoleListener | undefined {
            return consoleHost.listeners[`napuketto-login-${selfId}/${action}`];
        },
        dispose() {
            for (const dispose of effects) {
                dispose();
            }
            effects.clear();
            return bot.stop();
        },
        click(action: "refresh-qr" | "relogin" | "qr-login", client: TestConsoleClient = {}) {
            const entry = consoleHost.listeners[`napuketto-login-${selfId}/${action}`];
            if (entry === undefined) {
                throw new Error(`面板事件未注册: ${action}`);
            }
            entry.callback.call(client, { selfId });
        },
    };
}

const launch = vi.mocked(launchSelfHost);
let children: IpcChild[];
let baseDir: string;
let logRecords: { name: string; type: string; content: string }[];

beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    logRecords = [];
    Logger.levels = { base: Logger.INFO, onebot: Logger.ERROR };
    Logger.targets = [
        { record: ({ name, type, content }) => logRecords.push({ name, type, content }) },
    ];
    baseDir = mkdtempSync(join(tmpdir(), "napuketto-console-test-"));
    launch.mockReset().mockImplementation(async () => {
        const child = new IpcChild();
        children.push(child);
        return { child: child as unknown as ChildProcess, bootJsPath: "test-qq/self-host.cjs" };
    });
});

afterEach(() => {
    for (const child of children) {
        child.emit("exit", 0, null);
        child.emit("close");
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Logger.levels = originalLogLevels;
    Logger.targets = originalLogTargets;
    rmSync(baseDir, { recursive: true, force: true });
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
    it.each([
        ["默认 debug", SELF_ID, undefined, "10002", "silent"],
        ["silent", "10002", "silent", SELF_ID, undefined],
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
        const payload = { selfId: SELF_ID, qr: { qrcodeUrl: "https://current.example/qr" } };
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

        const payload = { selfId: SELF_ID, qr: { qrcodeUrl: "https://current.example/qr" } };
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
        const payload = { selfId: SELF_ID, qr: { qrcodeUrl: "https://current.example/qr" } };
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

describe("Bot 启停生命周期", () => {
    it("同一对象正常 stop 后再次 start，使用新 driver 并重新上线", async () => {
        const { bot } = setupPanel();
        const first = await startBot(bot);
        first.ready();
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledOnce();
        expect(bot["driver"]?.currentState).toBe("ready");

        const stopping = bot.stop();
        first.emit("exit", 0, null);
        await stopping;
        expect(bot["driver"]).toBeNull();

        const second = await startBot(bot);
        expect(second).not.toBe(first);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(bot["identityMismatch"]).toBe(false);
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
        expect(bot["identityMismatch"]).toBe(true);
        expect(bot.status).toBe(0);

        // 账号校验已同步停 driver；此时再次 start 要等旧宿主确认退出。
        const restarting = bot.start();
        first.emit("exit", 0, null);
        await restarting;
        await vi.advanceTimersByTimeAsync(0);

        const second = latestChild();
        expect(second).not.toBe(first);
        expect(bot["identityMismatch"]).toBe(false);
        second.ready(SELF_ID);
        await vi.advanceTimersByTimeAsync(0);
        expect(bot.online).toHaveBeenCalledOnce();
        expect(bot["clientRef"].current).not.toBeNull();
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
        expect(bot["driver"]).toBeNull();
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
        expect(bot["driver"]).toBeNull();
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
        const oldDriver = bot["driver"];
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
        expect(bot["clientRef"].current).not.toBeNull();
        expect(bot["login"].snapshot.self?.uin).toBe(SELF_ID);
        expect(bot["login"].snapshot.qr).toBeUndefined();
    });
});

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

describe("Koishi 标准动作到子进程 IPC 的接线", () => {
    const groupId = "50001";
    const userId = "20001";
    const group = Number(groupId);
    const user = Number(userId);
    const member = {
        group_id: group,
        user_id: user,
        nickname: "昵称",
        card: "群名片",
        title: "头衔",
        role: "admin",
        join_time: 1_700_000_000,
    };
    const memberResult = {
        user: { id: userId, name: "昵称" },
        nick: "群名片",
        title: "头衔",
        roles: [{ id: "admin" }],
        joinedAt: 1_700_000_000_000,
    };

    async function startReadyBot() {
        const { bot } = setupPanel();
        const child = await startBot(bot);
        child.ready();
        const respond = (action: string, data: unknown) => {
            child.actionResponses.set(action, { status: "ok", retcode: 0, data });
        };
        const expectAction = (action: string, params?: Record<string, unknown>) => {
            const last = child.received.at(-1);
            expect(last?.type === "action" ? last.payload : undefined).toEqual(
                params === undefined ? { action } : { action, params },
            );
        };
        return { bot, child, respond, expectAction };
    }

    it("读取用户资料或指定群内的用户，保留 QQ 号和昵称", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_stranger_info", { user_id: user, nickname: "QQ 昵称" });
        respond("get_group_member_info", member);

        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: "QQ 昵称" });
        expectAction("get_stranger_info", { user_id: user });
        await expect(bot.getUser(userId, groupId)).resolves.toEqual(memberResult.user);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        respond("get_stranger_info", { user_id: user, nickname: "" });
        await expect(bot.getUser(userId)).resolves.toEqual({ id: userId, name: userId });
    });

    it("读取成员及单页成员列表，过滤无法解析 QQ 号的成员", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("get_group_member_info", member);
        respond("get_group_member_list", [member, { ...member, user_id: Number.NaN }]);

        await expect(bot.getGuildMember(groupId, userId)).resolves.toEqual(memberResult);
        expectAction("get_group_member_info", { group_id: group, user_id: user });
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [memberResult] });
        expectAction("get_group_member_list", { group_id: group });
        respond("get_group_member_list", []);
        await expect(bot.getGuildMemberList(groupId)).resolves.toEqual({ data: [] });
    });

    it("群频道查询只返回指定群的文本频道，缺失时报告 NOT_FOUND", async () => {
        const { bot, child, expectAction } = await startReadyBot();
        child.actionResponses.set("group.getGroupList", [
            { groupCode: "50002", groupName: "其他群" },
            { groupCode: groupId, groupName: "目标群" },
        ]);

        await expect(bot.getChannelList(groupId)).resolves.toEqual({
            data: [{ id: groupId, name: "目标群", type: 0 }],
        });
        expectAction("group.getGroupList");
        await expect(bot.getChannelList("50003")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("只在永久踢人时设置拒绝再次入群", async () => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_kick", null);

        await expect(bot.kickGuildMember(groupId, userId)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: false,
        });
        await expect(bot.kickGuildMember(groupId, userId, true)).resolves.toBeUndefined();
        expectAction("set_group_kick", {
            group_id: group,
            user_id: user,
            reject_add_request: true,
        });
    });

    it.each([
        [30_000, 30],
        [1_001, 2],
        [1, 1],
        [0, 0],
    ])("禁言 %i 毫秒对应 %i 秒，零值解除禁言", async (duration, seconds) => {
        const { bot, respond, expectAction } = await startReadyBot();
        respond("set_group_ban", null);

        await expect(
            bot.muteGuildMember(groupId, userId, duration, "群管理说明"),
        ).resolves.toBeUndefined();
        expectAction("set_group_ban", { group_id: group, user_id: user, duration: seconds });
    });

    it("在发送 IPC 之前拒绝非法 QQ 号、分页令牌和时长", async () => {
        const { bot, child } = await startReadyBot();
        const sent = child.received.length;

        await expect(bot.getUser("9007199254740993")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.kickGuildMember("1e5", userId)).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getGuildMemberList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        await expect(bot.getChannelList(groupId, "extra")).rejects.toMatchObject({
            code: "INVALID_PARAM",
        });
        for (const duration of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(bot.muteGuildMember(groupId, userId, duration)).rejects.toMatchObject({
                code: "INVALID_PARAM",
            });
        }
        expect(child.received).toHaveLength(sent);
    });

    it("拒绝 OB11 权限及资源失败、错误标识和异常响应", async () => {
        const { bot, child, respond } = await startReadyBot();
        child.actionResponses.set("set_group_kick", { status: "failed", retcode: 101, data: null });
        child.actionResponses.set("get_stranger_info", {
            status: "failed",
            retcode: 102,
            data: null,
        });

        await expect(bot.kickGuildMember(groupId, userId)).rejects.toMatchObject({ code: "101" });
        await expect(bot.getUser(userId)).rejects.toMatchObject({ code: "102" });
        respond("get_group_member_info", { ...member, user_id: user + 1 });
        await expect(bot.getGuildMember(groupId, userId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        respond("get_group_member_list", [{ ...member, group_id: group + 1 }]);
        await expect(bot.getGuildMemberList(groupId)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
        await expect(bot.muteGuildMember(groupId, userId, 5000)).rejects.toMatchObject({
            code: "INVALID_RESPONSE",
        });
    });

    it.each([
        {
            event: { request_type: "friend", flag: "0000700" },
            type: "friend-request",
            method: "handleFriendRequest",
            action: "set_friend_add_request",
            params: { flag: "0000700", approve: true, remark: "审批说明" },
        },
        {
            event: {
                request_type: "group",
                sub_type: "add",
                group_id: group,
                flag: "90071992547409930",
            },
            type: "guild-member-request",
            method: "handleGuildMemberRequest",
            action: "set_group_add_request",
            params: { flag: "90071992547409930", approve: false, reason: "审批说明" },
        },
    ] as const)(
        "用 $type Session 的 messageId 调用标准审批方法",
        async ({ event, type, method, action, params }) => {
            const { bot, child, respond, expectAction } = await startReadyBot();
            respond(action, null);
            child.send({
                v: IPC_VERSION,
                type: "event",
                payload: {
                    service: "ob11",
                    name: "request",
                    args: [
                        { post_type: "request", self_id: Number(SELF_ID), user_id: user, ...event },
                    ],
                },
            });
            await vi.advanceTimersByTimeAsync(0);
            const [session] = vi.mocked(bot.dispatch).mock.lastCall ?? [];
            expect(session).toMatchObject({ type, messageId: event.flag });
            if (session?.messageId === undefined) {
                throw new Error("Koishi 请求 Session 缺少 messageId");
            }
            await expect(
                bot[method](session.messageId, params.approve, "审批说明"),
            ).resolves.toBeUndefined();
            expectAction(action, params);
        },
    );
});
