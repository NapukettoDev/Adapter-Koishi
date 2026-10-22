/**
 * identity.ts：账号一致性校验纯逻辑（自 bot.ts checkIdentity 拆出，2026-09-10
 * 单测补齐）。checkIdentity 是 2026-08-20 生产事故根治点（QR 谁扫谁登录 →
 * 配置 selfId 与实际 uin 不一致时数据目录污染 + koishi assignee/binding 写错
 * 账号 → 群消息被受理人闸门静默丢弃，见 bot.ts 注释）。副作用挂在 koishi Bot
 * 基类（offline）与 private 字段上，单测不可 import koishi（docs/guides/development.md 单测边界）
 * ——判定抽纯函数、拒绝动作抽注入式执行器（对齐 login-actions
 * planRelogin/executeRelogin 模式），bot.ts 的 checkIdentity 只剩组装。
 */

/** 账号一致性判定结果（allow：放行上线；mismatch：拒绝上线）。 */
export type IdentityDecision =
    | { readonly kind: "allow" }
    | {
          readonly kind: "mismatch";
          /** 配置 selfId（提示文案/Error 插值用）。 */
          readonly configSelfId: string;
          /** 实际登录 uin。 */
          readonly actualUin: string;
      };

/**
 * 账号一致性判定：实际 uin 缺失（未拉到 selfInfo）/ 空串 / 等于配置 selfId
 * → 放行；否则不一致。与原 checkIdentity 判定逐字对齐。
 */
export function evaluateIdentity(
    configSelfId: string,
    actualUin: string | undefined,
): IdentityDecision {
    if (actualUin === undefined || actualUin === "" || actualUin === configSelfId) {
        return { kind: "allow" };
    }
    return { kind: "mismatch", configSelfId, actualUin };
}

/** 拒绝上线动作宿主（bot.ts 注入 logger/identityMismatch/driver/offline 真实接线）。 */
export interface IdentityMismatchSink {
    /** logger.error：可操作提示（改 selfId 或换账号重扫）。 */
    onError: (message: string, ...args: unknown[]) => void;
    /** 置 identityMismatch 闸门（dispatch 拒派发 + onExit 判主动断开）。 */
    setMismatch: () => void;
    /** 停 driver 子进程。 */
    stopDriver: () => void;
    /** 拒绝上线（koishi Bot offline）。 */
    offline: (error: Error) => void;
}

/** 不一致处置：置闸门 → error 提示 → 停 driver → 拒绝上线（原 checkIdentity 顺序）。 */
export function rejectIdentityMismatch(
    decision: Extract<IdentityDecision, { kind: "mismatch" }>,
    sink: IdentityMismatchSink,
): void {
    sink.setMismatch();
    sink.onError(
        "[napuketto] 账号不一致：配置 selfId=%s，实际登录 uin=%s —— 已拒绝上线，" +
            "以免污染数据目录与 koishi 的 channel.assignee/binding（会导致群消息被" +
            "静默丢弃）。请把插件配置 selfId 改成 %s，或改用 %s 重新扫码登录。",
        decision.configSelfId,
        decision.actualUin,
        decision.actualUin,
        decision.configSelfId,
    );
    sink.stopDriver();
    sink.offline(
        new Error(
            `账号不一致：配置 selfId=${decision.configSelfId}，实际登录 uin=${decision.actualUin}`,
        ),
    );
}
