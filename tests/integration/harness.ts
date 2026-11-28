import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { launchSelfHost } from "@napuketto/loader";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { NapukettoBot } from "../../src/bot/bot.js";
import type { LogLevel } from "../../src/config.js";
import type { LoginPanelPayload } from "../../src/console/model.js";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    IPC_VERSION,
    type IpcMessage,
} from "../../src/runtime/ipc/index.js";
import { PNG_BASE64 } from "../fixtures/png.js";

vi.mock("koishi", async () => {
    const { mockH } = await import("../helpers/events.js");
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
vi.mock("../../src/config.js", () => ({ napukettoConfigSchema: {} }));
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

export const SELF_ID = "10001";
export const RESTART_DELAY_MS = 100;
export const selfInfo = { uin: SELF_ID, uid: "u1", nick: "测试账号" };

// 复用 Satori 的实际 Logger，实现名称共享等级的回归测试，同时保持 Koishi 运行时为 mock。
const requireKoishi = createRequire(import.meta.resolve("koishi"));
const requireSatori = createRequire(requireKoishi.resolve("@satorijs/core"));
export const { Logger } = requireSatori("cordis") as Pick<typeof import("koishi"), "Logger">;
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

    qr(qrcodeUrl = "https://example.com/qr", pngBase64 = PNG_BASE64): void {
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

export function createConsole() {
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
            setup({ ...createScope(effects), root: this, set: this.set.bind(this, effects) });
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
export interface TestConsoleClient {
    auth?: { authority: number; expiredAt: number };
}

/** 断言用 provider 形状（真实实例由 bot 构造，运行时经 mock DataService）。 */
interface TestLoginProvider {
    readonly options: { authority?: number; immediate?: boolean } | undefined;
    get(forced?: boolean, client?: TestConsoleClient): Promise<LoginPanelPayload>;
}

interface TestConsoleListener {
    readonly callback: (
        this: TestConsoleClient,
        data: { selfId: string },
    ) => boolean | Promise<boolean>;
    readonly options: { authority?: number } | undefined;
}

export function setupPanel(selfId = SELF_ID, consoleHost = createConsole(), logLevel?: LogLevel) {
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
            void entry.callback.call(client, { selfId });
        },
    };
}

export const launch = vi.mocked(launchSelfHost);
let children: IpcChild[];
let baseDir: string;
export let logRecords: { name: string; type: string; content: string }[];

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

export async function startBot(bot: NapukettoBot): Promise<IpcChild> {
    await bot.start();
    await vi.advanceTimersByTimeAsync(0);
    return latestChild();
}

export function latestChild(): IpcChild {
    const child = children.at(-1);
    if (child === undefined) {
        throw new Error("子进程未启动");
    }
    return child;
}
