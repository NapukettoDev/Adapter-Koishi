import { type Client, type Console, DataService, type Events } from "@koishijs/plugin-console";
import type { Context, Logger } from "koishi";
import {
    type ConsoleAuthClient,
    type LoginPanelPayload,
    loginPanelAccessOptions,
    passesLoginPanelAuthority,
    redactLoginPanelPayload,
} from "./model.js";

declare module "@koishijs/plugin-console" {
    namespace Console {
        interface Services {
            [key: `napuketto-login-${string}`]: NapukettoLoginProvider;
        }
    }
    interface Events {
        [key: `napuketto-login-${string}/relogin`]: (data: {
            selfId: string;
        }) => boolean | Promise<boolean>;
        [key: `napuketto-login-${string}/qr-login`]: (data: {
            selfId: string;
        }) => boolean | Promise<boolean>;
        [key: `napuketto-login-${string}/refresh-qr`]: (data: {
            selfId: string;
        }) => boolean | Promise<boolean>;
    }
}

interface LoginPanelBinding {
    getPayload: () => LoginPanelPayload;
    logger: Logger;
    onRelogin: () => boolean;
    onQrLogin: () => boolean;
    onRefreshQr: () => Promise<boolean>;
}

class NapukettoLoginProvider extends DataService<LoginPanelPayload> {
    private binding: LoginPanelBinding | undefined;

    constructor(
        ctx: Context,
        serviceId: string,
        private readonly selfId: string,
        private readonly disposeScope: () => void,
    ) {
        // 直接构造时 immediate 只标记 expose，服务值由独立注入作用域显式注册。
        super(ctx, serviceId as keyof Console.Services, {
            immediate: true,
            ...loginPanelAccessOptions(),
        });
        ctx.on("dispose", () => {
            this.binding = undefined;
        });
        ctx.on("console/connection", () => {
            if (this.binding !== undefined) {
                void this.refresh();
            }
        });
        this.addControlListener(ctx, `${serviceId}/relogin`, (binding) => binding.onRelogin());
        this.addControlListener(ctx, `${serviceId}/qr-login`, (binding) => binding.onQrLogin());
        this.addControlListener(ctx, `${serviceId}/refresh-qr`, (binding) => binding.onRefreshQr());
    }

    bind(ctx: Context, binding: LoginPanelBinding): () => void {
        this.binding = binding;
        ctx.on("dispose", () => {
            if (this.binding === binding) {
                this.disposeScope();
            }
        });
        return () => {
            if (this.binding === binding) {
                void this.refresh();
            }
        };
    }

    private addControlListener(
        ctx: Context,
        name: string,
        action: (binding: LoginPanelBinding) => boolean | Promise<boolean>,
    ): void {
        const provider = this;
        const { listeners } = ctx.console;
        ctx.console.addListener(
            name as keyof Events,
            function (this: Client, data: unknown): boolean | Promise<boolean> {
                const binding = provider.binding;
                if (binding === undefined || !provider.canAccess(this)) {
                    return false;
                }
                if (
                    data === null ||
                    typeof data !== "object" ||
                    !("selfId" in data) ||
                    data.selfId !== provider.selfId
                ) {
                    binding.logger.debug("[napuketto] 控制台登录操作与账号不匹配");
                    return false;
                }
                return action(binding);
            },
            loginPanelAccessOptions(),
        );
        const listener = listeners[name];
        // Console.addListener 仅写共享表，销毁作用域时需要按监听器对象清理。
        ctx.on("dispose", () => {
            if (listeners[name] === listener) {
                delete listeners[name];
            }
        });
    }

    private canAccess(client: Client): boolean {
        // AuthService 公开注册为 auth。每次交付重新检查，覆盖 Auth 的启用和卸载。
        return passesLoginPanelAuthority(
            client as ConsoleAuthClient,
            this.ctx.root.get("auth") != null,
        );
    }

    override async get(_forced?: boolean, client?: Client): Promise<LoginPanelPayload> {
        if (client === undefined || !this.canAccess(client)) {
            this.binding?.logger.debug("[napuketto] 控制台客户端权限不足，返回脱敏登录快照");
            return redactLoginPanelPayload(this.selfId);
        }
        const payload = this.binding?.getPayload();
        return payload?.selfId === this.selfId
            ? payload
            : { state: "idle", selfId: this.selfId, generation: 0 };
    }
}

export function bindLoginProvider(
    ctx: Context,
    selfId: string,
    binding: LoginPanelBinding,
): () => void {
    const serviceId = `napuketto-login-${selfId}`;
    const serviceName = `console.services.${serviceId}`;
    let provider = ctx.root.get(serviceName) as NapukettoLoginProvider | undefined;
    if (provider === undefined) {
        // Provider 的生命周期独立于任一 Bot，接管时保留同一数据服务与监听器。
        const scope = ctx.root.inject(["console"], (owner) => {
            const service = new NapukettoLoginProvider(owner, serviceId, selfId, () => {
                scope.dispose();
            });
            owner.set(serviceName, service);
        });
        provider = ctx.root.get(serviceName) as NapukettoLoginProvider | undefined;
        if (provider === undefined) {
            scope.dispose();
            throw new Error(`[napuketto] 登录面板服务注册失败: ${serviceId}`);
        }
    }
    return provider.bind(ctx, binding);
}
