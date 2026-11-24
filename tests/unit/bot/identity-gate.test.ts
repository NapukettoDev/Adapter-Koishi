/**
 * identity-gate.test.ts：账号身份闸门与软重登轮次单测。
 *
 * 覆盖：ready 缺身份时补拉 getSelf、查询失败/空值的可恢复失败态、错账号拒绝、
 * 软重登期间动作/派发关闭、旧查询响应在换轮后作废、恢复正确账号后重新上线。
 */
import { describe, expect, it, vi } from "vitest";
import { BotLifecycleController } from "../../../src/bot/lifecycle.js";
import { NapukettoLoginState } from "../../../src/console/login-state.js";
import type { DriverEvents } from "../../../src/runtime/driver/types.js";
import {
    decodeIpcMessage,
    encodeIpcMessage,
    IPC_VERSION,
    type IpcMessage,
    NapukettoIpcClient,
} from "../../../src/runtime/ipc/index.js";
import { BOT_STATUS } from "../../../src/shared.js";
import { MemoryLinePair } from "../../helpers/ipc.js";

const SELF_ID = "10001";
const SELF = { uin: SELF_ID, uid: "u1", nick: "当前账号" } as const;

type LifecycleHost = ConstructorParameters<typeof BotLifecycleController>[0];
type ActionMessage = Extract<IpcMessage, { type: "action" }>;

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function setup() {
    const login = new NapukettoLoginState();
    const pair = new MemoryLinePair();
    const client = new NapukettoIpcClient(pair);
    const actions: ActionMessage[] = [];
    pair.peer.onLine((line) => {
        const message = decodeIpcMessage(line);
        if (message?.type === "action") {
            actions.push(message);
        }
    });
    const bot = {
        status: 0,
        get isActive() {
            return this.status !== 0 && this.status !== BOT_STATUS.DISCONNECT;
        },
        online: vi.fn(() => {
            bot.status = BOT_STATUS.ONLINE;
        }),
        offline: vi.fn(() => {
            bot.status = 0;
        }),
        getLogin: vi.fn<LifecycleHost["bot"]["getLogin"]>().mockResolvedValue({} as never),
    };
    let events: DriverEvents | undefined;
    const stop = vi.fn(async () => {
        client.close();
    });
    const driver = {
        start: vi.fn(() => {}),
        stop,
        restartLogin: vi.fn(() => true),
        currentState: "ready" as const,
        currentClient: client,
    };
    const createDriver = vi.fn<LifecycleHost["createDriver"]>((eventSink) => {
        events = eventSink;
        return driver;
    });
    const lifecycle = new BotLifecycleController({
        bot,
        login,
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getBridge: () => ({
            handle: vi.fn(),
            resetMessageBaseline: vi.fn(),
            cancelPending: vi.fn(),
        }),
        getSelfId: () => SELF_ID,
        stopBot: async () => {
            bot.status = 0;
        },
        syncUser: vi.fn(),
        createDriver,
    });
    return { lifecycle, events: () => events, actions, bot, login, pair, client, driver, stop };
}

function respond(pair: MemoryLinePair, actions: ActionMessage[], value: unknown, ok = true): void {
    const action = actions.at(-1);
    if (action === undefined) {
        throw new Error("没有待响应的 action");
    }
    pair.peer.write(
        encodeIpcMessage({
            v: IPC_VERSION,
            type: "result",
            id: action.id,
            payload: ok
                ? { ok: true, value }
                : { ok: false, error: { code: "X", message: "失败" } },
        }),
    );
}

describe("BotLifecycleController 身份闸门", () => {
    it("ready 缺少身份时查询 getSelf，验证前不 online、不派发", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onReady?.();
        expect(harness.actions.map(({ payload }) => payload.action)).toEqual(["login.getSelf"]);
        expect(harness.bot.online).not.toHaveBeenCalled();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.lifecycle.client).toBeNull();
        expect(harness.login.snapshot.self).toBeUndefined();

        respond(harness.pair, harness.actions, {
            uin: SELF_ID,
            uid: SELF.uid,
            nickname: SELF.nick,
        });
        await flush();

        expect(harness.bot.online).toHaveBeenCalledOnce();
        expect(harness.lifecycle.dispatchClient).toBe(harness.client);
        expect(harness.login.snapshot.self).toEqual(SELF);
        await harness.lifecycle.stop();
    });

    it("getSelf 返回错账号 → 停 driver、offline，身份不复用", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onReady?.();
        respond(harness.pair, harness.actions, {
            uin: "20002",
            uid: "u2",
            nickname: "错误账号",
        });
        await flush();

        expect(harness.bot.online).not.toHaveBeenCalled();
        expect(harness.bot.offline).toHaveBeenCalledOnce();
        expect(harness.stop).toHaveBeenCalledOnce();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.self).toBeUndefined();
        expect(harness.login.snapshot.lastError).toContain("账号不一致");
    });

    it("查询失败/空结果进入可恢复失败态，后续正确登录可重新上线", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onReady?.();
        respond(harness.pair, harness.actions, null);
        await flush();

        expect(harness.bot.online).not.toHaveBeenCalled();
        expect(harness.stop).not.toHaveBeenCalled();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.lastError).toContain("登录身份");

        harness.events()?.onLogin?.({ state: "logged_in", selfInfo: SELF });
        await flush();
        expect(harness.bot.online).toHaveBeenCalledOnce();
        expect(harness.lifecycle.dispatchClient).toBe(harness.client);
        await harness.lifecycle.stop();
    });

    it("getSelf 请求拒绝同样不放开闸门", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onReady?.();
        respond(harness.pair, harness.actions, null, false);
        await flush();

        expect(harness.bot.online).not.toHaveBeenCalled();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.lastError).toContain("获取登录身份失败");
        await harness.lifecycle.stop();
    });

    it("软重登开始即关闭动作与派发，旧 getSelf 响应换轮后作废", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onReady?.();
        const stale = harness.actions.at(-1);
        if (stale === undefined) {
            throw new Error("缺少身份查询");
        }

        harness.events()?.onRelogin?.();
        expect(harness.bot.status).toBe(BOT_STATUS.CONNECT);
        expect(harness.lifecycle.client).toBeNull();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.self).toBeUndefined();

        harness.pair.peer.write(
            encodeIpcMessage({
                v: IPC_VERSION,
                type: "result",
                id: stale.id,
                payload: { ok: true, value: { uin: SELF_ID, uid: SELF.uid, nickname: SELF.nick } },
            }),
        );
        await flush();
        expect(harness.bot.online).not.toHaveBeenCalled();

        harness.events()?.onLogin?.({ state: "logged_in", selfInfo: SELF });
        harness.events()?.onReassembled?.();
        await flush();
        expect(harness.bot.online).toHaveBeenCalledOnce();
        expect(harness.lifecycle.dispatchClient).toBe(harness.client);
        await harness.lifecycle.stop();
    });

    it("宿主退出立即清空身份、动作与派发闸门", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onLogin?.({ state: "logged_in", selfInfo: SELF });
        harness.events()?.onReady?.();
        await flush();
        expect(harness.lifecycle.dispatchClient).toBe(harness.client);

        harness.events()?.onExit?.({ code: 1, signal: null, reason: "crash" });
        expect(harness.lifecycle.client).toBeNull();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.state).toBe("idle");
        expect(harness.login.snapshot.self).toBeUndefined();
        expect(harness.bot.offline).toHaveBeenCalledOnce();
        await harness.lifecycle.stop();
    });

    it("软重登后登录成错账号 → 再次拒绝上线", async () => {
        const harness = setup();
        await harness.lifecycle.start();
        harness.events()?.onLogin?.({ state: "logged_in", selfInfo: SELF });
        harness.events()?.onReady?.();
        await flush();
        expect(harness.bot.online).toHaveBeenCalledOnce();

        harness.events()?.onRelogin?.();
        harness.events()?.onLogin?.({
            state: "logged_in",
            selfInfo: { uin: "20002", uid: "u2", nick: "错误账号" },
        });
        harness.events()?.onReassembled?.();
        await flush();

        expect(harness.bot.online).toHaveBeenCalledOnce();
        expect(harness.bot.offline).toHaveBeenCalledOnce();
        expect(harness.stop).toHaveBeenCalledOnce();
        expect(harness.lifecycle.dispatchClient).toBeNull();
        expect(harness.login.snapshot.self).toBeUndefined();
    });
});
