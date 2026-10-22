/**
 * types.ts：控制台登录面板类型（docs/internals/console.md）。
 *
 * LoginPanelPayload 是 DataService 下行到前端 store 的形状：
 * 前端 client/settings.vue 从 store['napuketto-login-<uin>'] 读取。
 */
import type { LoginState, QrCodeData, SelfInfo } from "@napuketto/kernel";

/** 控制台登录面板 payload（前后端契约，JSON 序列化安全）。 */
export interface LoginPanelPayload {
    /** kernel 登录状态（idle/waiting_scan/scanned/logged_in/failed）。 */
    state: LoginState;
    /** 登录账号（QQ 号）——多账号隔离：serviceId 后缀 + 前端校验。 */
    selfId: string;
    /** 人类可读状态文案（面板主提示）。 */
    message?: string;
    /** 二维码完整 data URI（waiting_scan 时推送；前端直接 <img :src> 展示）。 */
    image?: string;
    /** 二维码（waiting_scan 时推送；pngBase64 + qrcodeUrl 链接兜底）。 */
    qr?: QrCodeData;
    /** 登录成功 selfInfo（logged_in 时）。 */
    self?: SelfInfo;
    /** 最近错误（failed 时）。 */
    lastError?: string;
}
