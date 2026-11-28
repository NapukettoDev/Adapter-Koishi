// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import ConfigGroup from "../../client/components/ConfigGroup.vue";
import Settings from "../../client/settings.vue";
import { send, store } from "../fixtures/koishi-client.js";
import { PNG_DATA_URI } from "../fixtures/png.js";

const ACCOUNT = "10001";
const OTHER = "10002";
const KEY = "napuketto-login-10001";
const URL = "https://example.com/login";
const cleanups = [];

beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    for (const key of Object.keys(store)) delete store[key];
});

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function attach(root, props) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root, props);
    let mounted = false;
    function unmount() {
        if (mounted) app.unmount();
        mounted = false;
        container.remove();
    }
    cleanups.push(unmount);
    function mount() {
        app.mount(container);
        mounted = true;
    }
    return { app, container, mount, unmount };
}

function qr(expiresIn = 120_000, account = ACCOUNT) {
    return {
        state: "waiting_scan",
        generation: 0,
        image: PNG_DATA_URI,
        qrUrl: URL,
        qrExpiresAt: Date.now() + expiresIn,
        selfId: account,
    };
}

function settings() {
    const fixture = attach(Settings);
    const { app, container } = fixture;
    const config = ref({ selfId: ACCOUNT });
    app.provide("manager.settings.local", ref({ name: "koishi-plugin-adapter-napuketto" }));
    app.provide("manager.settings.config", config);
    app.component("k-comment", defineComponent((_, { slots }) => () => h("div", slots.default?.())));
    app.component("k-button", defineComponent((_, { slots }) => () => h("button", slots.default?.())));
    app.component("k-icon", defineComponent(() => () => h("i")));
    fixture.mount();

    function button(text) {
        const element = Array.from(container.querySelectorAll("button")).find(
            (button) => button.textContent?.includes(text),
        );
        if (!element) throw new Error("未找到按钮 " + text);
        return element;
    }
    return { ...fixture, config, button };
}

describe("Vue 登录面板", () => {
    it("连续刷新各自等待，旧计时器和旧响应不能解除新请求", async () => {
        store[KEY] = qr();
        const panel = settings();
        const first = Promise.withResolvers();
        const second = Promise.withResolvers();
        send.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

        panel.button("刷新二维码").click();
        await nextTick();
        expect(panel.button("刷新中").disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);

        store[KEY] = qr();
        await nextTick();
        panel.button("刷新二维码").click();
        await nextTick();
        expect(send).toHaveBeenNthCalledWith(2, KEY + "/refresh-qr", { selfId: ACCOUNT });

        first.reject("unauthorized");
        await vi.advanceTimersByTimeAsync(2000);
        expect(panel.button("刷新中").disabled).toBe(true);
        expect(panel.container.querySelector("[role=alert]")).toBeNull();

        second.resolve(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(panel.button("刷新二维码").disabled).toBe(false);
        expect(panel.container.querySelector("[role=alert]")?.textContent).toContain("超时");
    });

    it.each(["拒绝", "忽略", "离线"])("%s 时解锁并保持二维码过期提示", async (outcome) => {
        store[KEY] = qr(1000);
        const panel = settings();
        await vi.advanceTimersByTimeAsync(1000);
        expect(panel.container.textContent).toContain("二维码已过期");
        expect(panel.container.querySelector("img")).toBeNull();

        if (outcome === "拒绝") send.mockRejectedValueOnce("unauthorized");
        if (outcome === "忽略") send.mockResolvedValueOnce(false);
        panel.button("刷新二维码").click();
        await nextTick();
        await nextTick();

        expect(panel.button("刷新二维码").disabled).toBe(false);
        expect(panel.container.textContent).toContain("二维码已过期");
        expect(panel.container.querySelector("[role=alert]")).not.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("扫码刷新遇到快速成功时清理两个计时器，下一次重登可以执行", async () => {
        store[KEY] = qr();
        const panel = settings();
        const previous = Promise.withResolvers();
        send.mockReturnValueOnce(previous.promise).mockResolvedValueOnce(true);
        panel.button("刷新二维码").click();

        store[KEY] = { state: "logged_in", generation: 0, selfId: ACCOUNT };
        await nextTick();
        expect(vi.getTimerCount()).toBe(0);
        expect(panel.container.querySelector("img")).toBeNull();
        expect(panel.button("重新登录").disabled).toBe(false);

        panel.button("重新登录").click();
        await nextTick();
        expect(send).toHaveBeenLastCalledWith(KEY + "/relogin", { selfId: ACCOUNT });
        previous.reject("unauthorized");
        store[KEY] = { state: "logged_in", generation: 1, selfId: ACCOUNT };
        await nextTick();
        expect(panel.button("重新登录").disabled).toBe(false);
        expect(panel.container.querySelector("[role=alert]")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("账号切换忽略错配快照，卸载清理二维码和在途请求计时器", async () => {
        store[KEY] = qr();
        const panel = settings();
        const previous = Promise.withResolvers();
        const current = Promise.withResolvers();
        send.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);

        panel.button("刷新二维码").click();
        const otherKey = "napuketto-login-" + OTHER;
        store[otherKey] = qr();
        panel.config.value = { selfId: OTHER };
        await nextTick();
        expect(panel.container.querySelector("img")).toBeNull();
        expect(panel.container.querySelector("button")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);

        store[otherKey] = qr(120_000, OTHER);
        await nextTick();
        panel.button("刷新二维码").click();
        await nextTick();
        expect(send).toHaveBeenLastCalledWith(otherKey + "/refresh-qr", { selfId: OTHER });
        previous.resolve(false);
        await nextTick();
        expect(panel.button("刷新中").disabled).toBe(true);

        expect(vi.getTimerCount()).toBe(2);
        panel.unmount();
        expect(vi.getTimerCount()).toBe(0);
        current.reject("unauthorized");
        await nextTick();
    });

    it("二维码只以 PNG 来源渲染，外链二次校验并禁止传递来源", async () => {
        const open = vi.spyOn(window, "open").mockImplementation(() => null);
        store[KEY] = { ...qr(), image: URL, qrUrl: "javascript:void(0)" };
        const panel = settings();
        expect(panel.container.querySelector("img")).toBeNull();
        expect(panel.container.textContent).not.toContain("打开登录链接");

        store[KEY] = qr(1000);
        await nextTick();
        panel.button("打开登录链接").click();
        expect(open).toHaveBeenCalledWith(URL, "_blank", "noopener,noreferrer");
        await vi.advanceTimersByTimeAsync(1000);
        expect(panel.container.textContent).not.toContain("打开登录链接");
    });
});

describe("Vue 配置分组", () => {
    it.each([undefined, null, { description: 12, required: true }])("容错 schema 元数据 %s", (meta) => {
        const { mount, container } = attach(ConfigGroup, { schema: { type: "object", meta } });
        mount();
        expect(container.querySelector("summary")?.textContent).toBe("高级配置");
        const schema = JSON.parse(container.querySelector("[data-schema]")?.getAttribute("data-schema") ?? "{}");
        expect(schema).toMatchObject({
            type: "object",
            meta: { role: "", description: "", collapse: false, ...(meta && { required: true }) },
        });
    });
});
