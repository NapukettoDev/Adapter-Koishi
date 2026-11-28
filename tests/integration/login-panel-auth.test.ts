import { createRequire } from "node:module";
import type { Client } from "@koishijs/plugin-console";
import type { App, Context, Universal } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoginPanelPayload } from "../../src/console/model.js";
import { bindLoginProvider } from "../../src/console/provider.js";
import { PNG_DATA_URI } from "../fixtures/png.js";

const require = createRequire(import.meta.url);

// Koishi 4.18 的 ESM loader 在 Node 24 无法初始化。隔离测试使用同版本的 CJS 导出。
vi.mock("@koishijs/plugin-console", () =>
    createRequire(import.meta.url)("@koishijs/plugin-console"),
);

const { App: KoishiApp, Logger } = require("koishi") as typeof import("koishi");
const { Console: OfficialConsole } =
    require("@koishijs/plugin-console") as typeof import("@koishijs/plugin-console");
const { default: OfficialAuth } = require("@koishijs/plugin-auth") as {
    default: new (ctx: Context, config: { admin: { enabled: boolean } }) => object;
};

const SELF_ID = "10001";
const OTHER_ID = "10002";
const ACTIONS = ["relogin", "qr-login", "refresh-qr"] as const;
const serviceKey = (account = SELF_ID): `napuketto-login-${string}` => `napuketto-login-${account}`;

interface Frame {
    type: string;
    body: { key?: string; id?: string; value?: unknown; error?: string };
}

class LocalSocket extends EventTarget {
    readonly frames: Frame[] = [];
    send(data: string): void {
        this.frames.push(JSON.parse(data) as Frame);
    }
    values(account = SELF_ID): unknown[] {
        return this.frames
            .filter(({ type, body }) => type === "data" && body.key === serviceKey(account))
            .map(({ body }) => body.value);
    }
}

class LocalConsole extends OfficialConsole {
    protected override resolveEntry(): string[] {
        return [];
    }
    connect(socket: LocalSocket): Client {
        this.accept(socket as unknown as Universal.WebSocket);
        const client = Object.values(this.clients).find((client) =>
            Object.is(client.socket, socket),
        );
        if (!client) throw new Error("Console 未登记连接");
        return client;
    }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function connection(console: LocalConsole) {
    const socket = new LocalSocket();
    const client = console.connect(socket);
    async function rpc(type: string, ...args: unknown[]) {
        const id = String(socket.frames.length);
        await client.receive({
            data: JSON.stringify({ type, args, id }),
        } as Universal.WebSocket.MessageEvent);
        return socket.frames.findLast((frame) => frame.type === "response" && frame.body.id === id)
            ?.body;
    }
    return { client, socket, rpc };
}

const token = "synthetic-test-token";
const apps: App[] = [];
afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.stop()));
    vi.restoreAllMocks();
});

async function setup(auth = true) {
    const app = new KoishiApp();
    apps.push(app);
    // Console 的旧版静态 inject 声明与 Koishi 的 Plugin 类型不同，运行时仍接受该插件。
    app.plugin(LocalConsole as new (ctx: Context) => LocalConsole);
    const identity = { authority: 3, expiredAt: Date.now() + 60_000 };
    if (auth) {
        app.set("database", {
            async get(table: string, _query: unknown, fields?: string[]) {
                if (table === "user") {
                    return [{ id: 1, name: "test", config: {}, authority: identity.authority }];
                }
                if (table === "token" && fields?.includes("expiredAt")) {
                    return [{ expiredAt: identity.expiredAt }];
                }
                return [];
            },
            set: vi.fn(),
            remove: vi.fn(),
        });
        app.plugin(OfficialAuth, { admin: { enabled: false } });
    }
    await app.start();
    expect(Boolean(app.get("auth"))).toBe(auth);

    function bind(account: string) {
        const payload: LoginPanelPayload = {
            selfId: account,
            generation: 1,
            state: "waiting_scan",
            image: PNG_DATA_URI,
            qrUrl: `https://example.com/${account}`,
            qrExpiresAt: Date.now() + 120_000,
        };
        const binding = {
            getPayload: () => payload,
            onRelogin: vi.fn(() => true),
            onQrLogin: vi.fn(() => true),
            onRefreshQr: vi.fn(async () => true),
            logger: new Logger("test"),
        };
        const publish = bindLoginProvider(app, account, binding);
        return { payload, publish, binding };
    }
    const panel = bind(SELF_ID);
    const console = app.console;
    if (!(console instanceof LocalConsole)) throw new Error("Console 未启动");
    return { console, panel, bind, identity };
}

async function expectDenied(
    conn: ReturnType<typeof connection>,
    panel: Awaited<ReturnType<typeof setup>>["panel"],
    pull = true,
) {
    if (pull) conn.client.refresh();
    await flush();
    expect(conn.socket.values()).toEqual([null]);
    conn.socket.frames.length = 0;
    panel.publish();
    await flush();
    expect(conn.socket.values()).toEqual([]);
    for (const action of ACTIONS) {
        expect(await conn.rpc(`${serviceKey()}/${action}`, { selfId: SELF_ID })).toMatchObject({
            error: "unauthorized",
        });
    }
}

describe("官方 Console 5.30.11 / Auth 4.1.7 登录面板接线", () => {
    it("匿名连接的主动拉取清空数据，广播及三个 RPC 均经过正式拦截器", async () => {
        const { console, panel } = await setup();
        const conn = connection(console);
        await expectDenied(conn, panel, false);
        expect(panel.binding.onRelogin).not.toHaveBeenCalled();
        expect(panel.binding.onQrLogin).not.toHaveBeenCalled();
        expect(panel.binding.onRefreshQr).not.toHaveBeenCalled();

        const provider = console.services[serviceKey()];
        if (!provider) throw new Error("登录面板未注册");
        expect(await provider.get(false, conn.client)).not.toHaveProperty("image");
        expect(await provider.get()).not.toHaveProperty("image");
    });

    it.each(["已登出", "过期", "低权限", "降权"] as const)(
        "%s 时拉取、广播和控制都拒绝，且 Provider 复核当前登录态",
        async (scenario) => {
            const { console, panel, identity } = await setup();
            const conn = connection(console);
            await flush();
            if (scenario === "低权限") identity.authority = 2;

            expect(await conn.rpc("login/token", 1, token)).not.toHaveProperty("error");
            await flush();
            if (scenario === "已登出") {
                expect(await conn.rpc("user/logout")).not.toHaveProperty("error");
            } else if (scenario === "过期") {
                vi.spyOn(Date, "now").mockReturnValue(identity.expiredAt);
            } else if (scenario === "降权") {
                identity.authority = 2;
                expect(await conn.rpc("login/token", 1, token)).not.toHaveProperty("error");
            }
            await flush();
            if (scenario === "已登出" || scenario === "降权") {
                expect(conn.socket.values().at(-1)).toBeNull();
            }

            conn.socket.frames.length = 0;
            await expectDenied(conn, panel);
            const provider = console.services[serviceKey()];
            if (!provider) throw new Error("登录面板未注册");
            expect(await provider.get(false, conn.client)).not.toHaveProperty("image");
            const callback = console.listeners[`${serviceKey()}/refresh-qr`]?.callback;
            await expect(
                Promise.resolve(callback?.call(conn.client, { selfId: SELF_ID })),
            ).resolves.toBe(false);
            expect(panel.binding.onRefreshQr).not.toHaveBeenCalled();
        },
    );

    it("管理员按账号接收拉取与广播，并通过官方 RPC 获取操作结果", async () => {
        const { console, panel, bind } = await setup();
        const other = bind(OTHER_ID);
        const conn = connection(console);
        const anonymous = connection(console);
        await flush();
        conn.socket.frames.length = 0;
        expect(await conn.rpc("login/token", 1, token)).not.toHaveProperty("error");
        await flush();
        expect(conn.socket.values()).toContainEqual(panel.payload);
        expect(conn.socket.values(OTHER_ID)).toContainEqual(other.payload);

        conn.socket.frames.length = 0;
        anonymous.socket.frames.length = 0;
        panel.publish();
        await flush();
        expect(conn.socket.values()).toEqual([panel.payload]);
        expect(conn.socket.values(OTHER_ID)).toEqual([]);
        expect(anonymous.socket.values()).toEqual([]);

        for (const action of ACTIONS) {
            const event = `${serviceKey()}/${action}`;
            for (const body of [null, {}, { selfId: OTHER_ID }]) {
                expect(await conn.rpc(event, body)).toMatchObject({ value: false });
            }
            expect(await conn.rpc(event, { selfId: SELF_ID })).toMatchObject({ value: true });
        }
        expect(panel.binding.onRelogin).toHaveBeenCalledOnce();
        expect(panel.binding.onQrLogin).toHaveBeenCalledOnce();
        expect(panel.binding.onRefreshQr).toHaveBeenCalledOnce();
        expect(other.binding.onRefreshQr).not.toHaveBeenCalled();

        conn.socket.frames.length = 0;
        panel.payload.selfId = OTHER_ID;
        panel.publish();
        conn.client.refresh();
        await flush();
        expect(conn.socket.values()).toEqual([
            { selfId: SELF_ID, generation: 0, state: "idle" },
            { selfId: SELF_ID, generation: 0, state: "idle" },
        ]);
    });

    it("无 Auth 配置时官方 Console 可匿名拉取、接收广播和操作本账号", async () => {
        const { console, panel } = await setup(false);
        const conn = connection(console);
        await flush();
        expect(conn.socket.values()).toContainEqual(panel.payload);
        conn.socket.frames.length = 0;
        panel.publish();
        await flush();
        expect(conn.socket.values()).toEqual([panel.payload]);
        expect(await conn.rpc(`${serviceKey()}/refresh-qr`, { selfId: SELF_ID })).toMatchObject({
            value: true,
        });
    });
});
