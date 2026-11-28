<!--
  settings.vue：Napuketto 扫码登录面板（docs/internals/console.md）。

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
          :image="qrImage"
          :message="data.message"
          :qr-url="qrUrl"
          :qr-expired="qrExpired"
          :qr-loading="qrLoading"
          @refresh-qr="runAction('refresh-qr')"
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
          @relogin="runAction('relogin')"
          @qr-login="runAction('qr-login')"
        />
        <p v-if="actionError" role="alert">{{ actionError }}</p>
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

type LoginState = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'failed';
type LoginAction = 'relogin' | 'qr-login' | 'refresh-qr';

interface LoginPanelData {
  selfId: string;
  state: LoginState;
  generation: number;
  message?: string;
  image?: string;
  qrUrl?: string;
  qrExpiresAt?: number;
  self?: { nick: string; uin: string };
  lastError?: string;
}

const PLUGIN_NAME = 'koishi-plugin-adapter-napuketto';
const SERVICE_PREFIX = 'napuketto-login';
const ACTION_WAIT_MS = 3000;

const local = inject('manager.settings.local', ref({ name: '' }));
const config = inject('manager.settings.config', ref<{ selfId?: unknown } | null>(null));
const current = inject('manager.settings.current', ref<{ disabled?: boolean } | null>(null));

const isCurrentPlugin = computed(() =>
  local.value?.name === PLUGIN_NAME && current.value?.disabled !== true,
);
const selfId = computed(() => {
  const value = config.value?.selfId;
  return isCurrentPlugin.value && typeof value === 'string' && /^[0-9]{5,11}$/.test(value)
    ? value
    : undefined;
});
const data = computed<LoginPanelData | null>(() => {
  if (!selfId.value) return null;
  const payload = store[`${SERVICE_PREFIX}-${selfId.value}`];
  if (payload === null || typeof payload !== 'object' || !('selfId' in payload)) return null;
  return payload.selfId === selfId.value ? payload as LoginPanelData : null;
});

const commentType = computed(() => {
  if (data.value?.state === 'logged_in') return 'success';
  if (data.value?.state === 'failed') return 'error';
  return 'warning';
});

const expiresAt = computed(() => {
  const value = data.value?.qrExpiresAt;
  return data.value?.state === 'waiting_scan' && typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
});
const qrImage = computed(() => {
  const image = data.value?.image;
  return typeof image === 'string' && image.startsWith('data:image/png;base64,') ? image : '';
});
const qrExpired = ref(false);
const qrUrl = computed(() => {
  const value = data.value?.qrUrl;
  if (typeof value !== 'string' || qrExpired.value) return '';
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
});

const pending = ref<symbol>();
const qrLoading = computed(() => pending.value !== undefined);
const actionError = ref('');
let actionTimer: number | undefined;

function clearAction(): void {
  window.clearTimeout(actionTimer);
  actionTimer = undefined;
  pending.value = undefined;
  actionError.value = '';
}

// 快照切换结束等待。比较状态和二维码字段，避免重复广播提前解锁。
watch(
  [selfId, () => data.value?.state, () => data.value?.generation,
    expiresAt, qrImage, () => data.value?.qrUrl, () => data.value?.lastError],
  clearAction,
);

watch([selfId, expiresAt], ([, deadline], _, onCleanup) => {
  qrExpired.value = deadline !== undefined && deadline <= Date.now();
  if (deadline === undefined || qrExpired.value) return;
  const timer = window.setTimeout(() => { qrExpired.value = true; }, deadline - Date.now());
  onCleanup(() => window.clearTimeout(timer));
}, { immediate: true });

onUnmounted(clearAction);

async function runAction(action: LoginAction): Promise<void> {
  const account = selfId.value;
  if (!account || !data.value || pending.value !== undefined) return;

  const token = Symbol();
  pending.value = token;
  actionError.value = '';
  function fail(message: string): void {
    // 迟到的响应可以属于已经切换的账号或已经结束的请求。
    if (pending.value !== token) return;
    clearAction();
    actionError.value = message;
  }

  actionTimer = window.setTimeout(() => fail('等待登录状态更新超时，请重试。'), ACTION_WAIT_MS);
  try {
    if (await send(`${SERVICE_PREFIX}-${account}/${action}`, { selfId: account }) !== true) {
      fail('登录操作未执行，请重试。');
    }
  } catch {
    fail('登录操作请求失败，请重试。');
  }
}

function openQrUrl(): void {
  const deadline = expiresAt.value;
  const url = qrUrl.value;
  if (url && deadline !== undefined && deadline > Date.now()) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
</script>

<style scoped>
.napuketto-settings {
  /* k-comment 默认上下 margin 2rem，在插件详情页里过宽，收紧为面板呼吸空间 */
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
