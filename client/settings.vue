<!--
  settings.vue：NapukettoQQ 扫码登录面板（docs/internals/console.md）。

  挂在插件详情页（client/index.ts 的 plugin-details slot）。数据源：
  - store['napuketto-login-<uin>']：后端 DataService 推送（状态 + 二维码）
  - send('napuketto-login-<uin>/relogin')：触发重新登录（重启子进程登录流程）
  - send('napuketto-login-<uin>/refresh-qr')：手动刷新二维码（IPC 直达，不重启子进程）

  结构（2026-08-14 拆分）：QrCodePanel（waiting_scan：二维码 + 过期遮罩 + 操作）、
  StatusSection（idle/scanned/logged_in/failed：文案 + 重新登录）。本文件保留共享状态
  （store 读取、过期计时、刷新 loading）与状态分发。

  视觉参照 koishi-plugin-adapter-bilibili-dm（MIT，仅借鉴布局/样式模式）。
-->
<template>
  <template v-if="isCurrentPlugin">
    <div v-if="data" class="napuketto-settings">
      <k-comment :type="commentType">
        <!-- waiting_scan：扫码登录（二维码 + 手动刷新；kernel 过期自动推新码）
             ⚠️ 标签必须用 PascalCase <QrCodePanel>：<qrcode-panel> 反推 QrcodePanel，
             与 import 的 QrCodePanel 大小写不匹配 → 编译器无法静态关联 → 渲染成空元素。 -->
        <QrCodePanel
          v-if="data.state === 'waiting_scan'"
          :image="data.image"
          :message="data.message"
          :qr="data.qr"
          :qr-expired="qrExpired"
          :qr-loading="qrLoading"
          @refresh-qr="refreshQr"
          @open-qr-url="openQrUrl"
        />
        <!-- 其余状态：idle/scanned/logged_in/failed -->
        <StatusSection
          v-else
          :state="data.state"
          :message="data.message"
          :self="data.self"
          :last-error="data.lastError"
          :qr-loading="qrLoading"
          @relogin="relogin"
          @qr-login="qrLogin"
        />
      </k-comment>
    </div>
    <!-- 正在查看本插件但数据尚未推送：轻量加载态 -->
    <k-comment v-else type="primary">
      <div class="loading-state">
        <span class="spinner" aria-hidden="true" />
        <span>正在加载登录状态…</span>
      </div>
    </k-comment>
  </template>
</template>

<script setup lang="ts">
import { send, store } from '@koishijs/client';
import { computed, inject, onUnmounted, ref, watch } from 'vue';
import QrCodePanel from './components/QrCodePanel.vue';
import StatusSection from './components/StatusSection.vue';

/** 登录状态（对齐 kernel LoginState 与后端推送结构）。 */
type LoginState = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'failed';

/** 后端推送的登录面板数据结构（store['napuketto-login-<uin>']）。 */
interface LoginPanelData {
  state: LoginState;
  message?: string;
  /** 二维码完整 data URI（waiting_scan 时有；直接 <img :src> 展示）。 */
  image?: string;
  /** state=waiting_scan 时有。 */
  qr?: { pngBase64: string; qrcodeUrl: string };
  /** state=logged_in 时有。 */
  self?: { nick: string; uin: string };
  lastError?: string;
}

/** 二维码有效期（毫秒，与提示文案「两分钟内」一致）。 */
const QR_EXPIRY_MS = 2 * 60 * 1000;
/** 插件名（package.json name，插件详情页校验用）。 */
const PLUGIN_NAME = 'koishi-plugin-adapter-napuketto';
/** DataService serviceId 前缀（与后端 src/console/provider.ts 对齐）。 */
const SERVICE_PREFIX = 'napuketto-login';

// ── 插件详情页上下文注入（识别当前查看的插件实例 + 配置） ──

const local = inject('manager.settings.local', ref({ name: '' }));
const config = inject('manager.settings.config', ref({}));
const current = inject('manager.settings.current', ref({}));

/** 是否正在查看本插件（且未被禁用）——决定面板是否渲染。 */
const isCurrentPlugin = computed(() => {
  const name = (local.value as { name?: string } | undefined)?.name;
  if (name !== PLUGIN_NAME) return false;
  return (current.value as { disabled?: boolean })?.disabled !== true;
});

/** 后端推送的登录面板数据（store['napuketto-login-<uin>']，Vue 响应式）。 */
const data = computed<LoginPanelData | null>(() => {
  if (!isCurrentPlugin.value) return null;
  // 从配置拿 selfId（多账号隔离：serviceId 按 uin 区分）
  const selfId = (config.value as { selfId?: string })?.selfId;
  if (!selfId) return null;
  // 从全局 store 按 serviceId 取后端推送的数据
  const serviceData = (store as Record<string, unknown>)[`${SERVICE_PREFIX}-${selfId}`];
  return serviceData !== undefined && typeof serviceData === 'object'
    ? (serviceData as LoginPanelData)
    : null;
});

/** 刷新二维码按钮 loading 态。 */
const qrLoading = ref(false);
/** 二维码过期遮罩（本地计时，kernel 自动推新码即复位）。 */
const qrExpired = ref(false);
/** 过期计时器。 */
let qrTimer: number | null = null;

/** 面板提示色（k-comment type）。⚠️ 不能用 'info'：k-comment 只有
 * primary/secondary/warning/success/error 五种类型有样式规则。 */
const commentType = computed(() => {
  const state = data.value?.state;
  if (state === 'logged_in') return 'success';
  if (state === 'failed') return 'error';
  return 'warning';
});

// ── 二维码过期计时（B站模板同款：2 分钟遮罩；kernel 过期自动推新码即复位） ──

function startQrExpiryTimer(): void {
  clearQrExpiryTimer();
  qrExpired.value = false;
  qrTimer = window.setTimeout(() => {
    qrExpired.value = true;
  }, QR_EXPIRY_MS) as unknown as number;
}

function clearQrExpiryTimer(): void {
  if (qrTimer !== null) {
    window.clearTimeout(qrTimer);
    qrTimer = null;
  }
}

onUnmounted(() => {
  clearQrExpiryTimer();
});

// 进入 waiting_scan：复位 loading + 启动过期计时
watch(
  () => data.value?.state,
  (state) => {
    if (state === 'waiting_scan') {
      qrLoading.value = false;
      startQrExpiryTimer();
    } else {
      clearQrExpiryTimer();
      qrExpired.value = false;
    }
  },
  { immediate: true },
);

// 新二维码到达（首次 / 手动刷新 / kernel 过期自动推新码）→ 复位 loading + 重启计时
watch(
  () => data.value?.qr?.pngBase64,
  () => {
    qrLoading.value = false;
    if (data.value?.state === 'waiting_scan') {
      startQrExpiryTimer();
    }
  },
);

// ── 指令上行：重新登录 / 刷新二维码 ──

function currentSelfId(): string {
  return (config.value as { selfId?: string })?.selfId ?? '';
}

function relogin(): void {
  const selfId = currentSelfId();
  if (!selfId) return;
  qrLoading.value = true;
  send(`${SERVICE_PREFIX}-${selfId}/relogin`, { selfId });
}

function qrLogin(): void {
  const selfId = currentSelfId();
  if (!selfId) return;
  qrLoading.value = true;
  send(`${SERVICE_PREFIX}-${selfId}/qr-login`, { selfId });
}

function refreshQr(): void {
  const selfId = currentSelfId();
  if (!selfId) return;
  qrLoading.value = true;
  qrExpired.value = false;
  send(`${SERVICE_PREFIX}-${selfId}/refresh-qr`, { selfId });
  // 兜底：刷新失败 / 无新二维码时 3s 后复位 loading
  setTimeout(() => {
    qrLoading.value = false;
  }, 3000);
}

/** 新窗口打开登录链接（无法扫码时兜底）。 */
function openQrUrl(): void {
  const url = data.value?.qr?.qrcodeUrl;
  if (url) {
    window.open(url, '_blank', 'noopener');
  }
}
</script>

<style lang="scss" scoped>
.napuketto-settings {
  // k-comment 默认上下 margin 2rem，在插件详情页里过宽，收紧为面板呼吸空间
  :deep(.k-comment) {
    margin: 0.75rem 0;
  }
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.spinner {
  display: inline-block;
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
