/**
 * koishijs-client.d.ts：@koishijs/client 本地类型 shim。
 *
 * 上游以 TS 源码发布（exports 直指 client/index.ts，无 types 条件），strict
 * 配置下会把上游源码的 122 条错误暴露进 IDE（skipLibCheck 只对 .d.ts 生效）。
 * 本项目按需维护声明并通过 tsconfig paths 重定向，
 * 使 strict 只作用于我们自己的代码；vite 构建不读 paths，不受影响。
 */
import type { Component } from 'vue';

export interface Context {
    slot(options: { type: string; component: Component; order?: number }): void;
    on(event: 'dispose', listener: () => void): void;
}

export const SchemaBase: {
    Schema: Component;
    extensions: Set<{ role: string; component: Component; important?: boolean }>;
};

/** 控制台 WebSocket 事件上行（同步发送，无 Promise）。 */
export function send(name: string, body?: unknown): void;

/** 控制台全局 store（DataService 推送数据，按 serviceId 隔离）。 */
export const store: Record<string, unknown>;
