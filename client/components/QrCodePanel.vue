<!--
  QrCodePanel.vue：扫码登录二维码面板（settings.vue 拆出，docs/internals/console.md）。

  仅负责 waiting_scan 状态展示：二维码 + 过期遮罩 + 刷新/打开链接操作。
  过期计时（qrExpired）与刷新 loading（qrLoading）由父组件管理（settings.vue
  持有共享状态），本组件纯展示 + 事件上行。
-->
<template>
  <div class="qrcode-panel">
    <!-- 二维码卡片（白底 + 阴影，参照 bilibili-dm） -->
    <div v-if="image" class="qrcode-container">
      <img class="qrcode" :src="image" alt="NapukettoQQ 登录二维码" />
      <!-- 本地 2 分钟过期遮罩（kernel 过期会自动推新码，新码到达即复位） -->
      <div v-if="qrExpired" class="refresh-overlay">
        <p>二维码已过期</p>
        <k-button :disabled="qrLoading" @click="emit('refresh-qr')">
          <span class="button-inner">
            <k-icon name="redo" />
            刷新二维码
          </span>
        </k-button>
      </div>
    </div>
    <!-- 二维码尚未到达：加载态 -->
    <div v-else class="qrcode-loading">
      <span class="spinner" aria-hidden="true" />
      <span>正在获取二维码…</span>
    </div>

    <p class="instructions">
      {{ message || '请使用手机 QQ 扫描二维码登录' }}
      <span v-if="image">，二维码两分钟内有效</span>
    </p>

    <div class="qrcode-actions">
      <k-button :disabled="qrLoading" @click="emit('refresh-qr')">
        <span class="button-inner">
          <span v-if="qrLoading" class="spinner" aria-hidden="true" />
          <k-icon v-else name="redo" />
          {{ qrLoading ? '刷新中…' : '刷新二维码' }}
        </span>
      </k-button>
      <k-button v-if="qr?.qrcodeUrl" frameless type="primary" @click="emit('open-qr-url')">
        <span class="button-inner">
          <k-icon name="external" />
          无法扫码？点此打开登录链接
        </span>
      </k-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/** 二维码信息（state=waiting_scan 时有）。 */
interface QrInfo {
  pngBase64: string;
  qrcodeUrl: string;
}

defineProps<{
  /** 二维码完整 data URI（直接 <img :src> 展示）。 */
  image?: string;
  /** 登录提示文案。 */
  message?: string;
  /** 二维码信息（打开登录链接用）。 */
  qr?: QrInfo;
  /** 本地过期遮罩（父组件计时）。 */
  qrExpired: boolean;
  /** 刷新按钮 loading。 */
  qrLoading: boolean;
}>();

const emit = defineEmits<{
  (e: 'refresh-qr'): void;
  (e: 'open-qr-url'): void;
}>();
</script>

<style lang="scss" scoped>
.qrcode-panel {
  // 面板内边距：顶部二维码/底部操作按钮离 k-comment 边缘留出呼吸空间
  padding: 0.75rem 0;
}

.qrcode-container {
  position: relative;
  display: inline-block;
  margin: 0 0 0.5rem;
  border: 1px solid var(--k-color-divider);
  padding: 10px;
  border-radius: 8px;
  background-color: #fff;
  box-shadow: 0 2px 8px rgb(0 0 0 / 10%);
}

.qrcode {
  display: block;
  max-width: 200px;
  // 二维码圆角（容器 8px，图片裁角 4px 内缩，视觉更柔和）
  border-radius: 4px;
  image-rendering: pixelated;
}

.qrcode-loading {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
  color: var(--k-text-normal);
}

.refresh-overlay {
  position: absolute;
  inset: 0;
  background-color: rgb(0 0 0 / 70%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 0.5rem;
  color: #fff;
  border-radius: 8px;

  p {
    margin: 0;
  }

  // 遮罩上的按钮改白字，避免深色底上不可读
  :deep(.k-button) {
    color: #fff;
    border-color: rgb(255 255 255 / 60%);

    &:hover:not(.disabled) {
      color: #fff;
      border-color: #fff;
    }
  }
}

.instructions {
  margin: 0 0 0.75rem;
  color: var(--k-text-normal);
}

.qrcode-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
}

.button-inner {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
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
