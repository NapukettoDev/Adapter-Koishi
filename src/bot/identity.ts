/** 扫码账号与配置不一致时，停止宿主并拒绝上线。 */

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

/** 拒绝上线动作宿主（生命周期控制器注入 logger/identityMismatch/driver/offline 真实接线）。 */
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
