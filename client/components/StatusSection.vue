<!--
  StatusSection.vue：登录状态信息面板（settings.vue 拆出，docs/internals/console.md）。

  展示非扫码状态（idle/scanned/logged_in/failed）的文案与操作：
  - idle：子进程启动中（加载态）
  - scanned：已扫码，待手机确认（加载态）
  - logged_in：登录成功（账号信息 + 重新登录）
  - failed：登录失败（错误 + 重新登录）
-->
<template>
  <!-- idle：未登录 / 子进程启动中 -->
  <div v-if="state === 'idle'" class="status-row">
    <span class="spinner" aria-hidden="true" />
    <span>{{ message || '正在启动登录…' }}</span>
  </div>

  <!-- scanned：已扫码，待手机确认 -->
  <div v-else-if="state === 'scanned'" class="status-row">
    <span class="spinner" aria-hidden="true" />
    <span>{{ message || '已扫码，请在手机上确认登录' }}</span>
  </div>

  <!-- logged_in：登录成功 -->
  <div v-else-if="state === 'logged_in'" class="status-block">
    <p class="status-title">{{ message || '登录成功' }}</p>
    <p v-if="self" class="account">
      <k-icon name="user" />
      <span class="nick">{{ self.nick }}</span>
      <span class="uin">{{ self.uin }}</span>
    </p>
    <div class="button-row">
      <k-button class="relogin-button" :disabled="qrLoading" @click="emit('relogin')">
        重新登录
      </k-button>
      <k-button class="relogin-button" :disabled="qrLoading" @click="emit('qr-login')">
        扫码登录
      </k-button>
    </div>
  </div>

  <!-- failed：登录失败 -->
  <div v-else-if="state === 'failed'" class="status-block">
    <p class="status-title">{{ lastError || message || '登录失败' }}</p>
    <div class="button-row">
      <k-button class="relogin-button" :disabled="qrLoading" @click="emit('relogin')">
        重新登录
      </k-button>
      <k-button class="relogin-button" :disabled="qrLoading" @click="emit('qr-login')">
        扫码登录
      </k-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 登录状态（对齐 kernel LoginState 与后端推送结构）。 */
type LoginState = 'idle' | 'waiting_scan' | 'scanned' | 'logged_in' | 'failed';

/** 登录账号信息（state=logged_in 时有）。 */
interface SelfInfo {
  nick: string;
  uin: string;
}

defineProps<{
  /** 登录状态（waiting_scan 由 QrCodePanel 处理，本组件不渲染）。 */
  state: LoginState;
  /** 状态提示文案。 */
  message?: string;
  /** 登录账号信息。 */
  self?: SelfInfo;
  /** 失败原因。 */
  lastError?: string;
  /** 重新登录按钮 loading（与二维码刷新共用，避免同时操作）。 */
  qrLoading: boolean;
}>();

const emit = defineEmits<{
  (e: 'relogin'): void;
  (e: 'qr-login'): void;
}>();
</script>

<style lang="scss" scoped>
.status-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.status-block {
  .status-title {
    margin: 0;
  }

  .account {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0.25rem 0 0.5rem;
    color: var(--k-text-normal);

    .k-icon {
      color: var(--k-color-success);
    }

    .uin {
      color: var(--k-text-light);
    }
  }
}

.relogin-button {
  margin-top: 0.5rem;
}

.button-row {
  display: flex;
  gap: 0.5rem;

  .relogin-button {
    margin-top: 0.5rem;
  }
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
