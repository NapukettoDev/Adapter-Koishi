<template>
  <details class="config-group">
    <summary>{{ description }}</summary>
    <component :is="SchemaBase.Schema" v-bind="$attrs" :schema="innerSchema" />
  </details>
</template>

<script setup lang="ts">
import { SchemaBase } from '@koishijs/client';
import { computed } from 'vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  schema: { meta?: { description?: unknown } | null };
}>();

const description = computed(() => {
  const value = props.schema.meta?.description;
  return typeof value === 'string' && value.trim() ? value : '高级配置';
});

const innerSchema = computed(() => ({
  ...props.schema,
  // 移除自定义角色，避免原生表单递归调用当前组件。
  meta: { ...props.schema.meta, role: '', description: '', collapse: false },
}));
</script>

<style scoped>
.config-group > summary {
  cursor: pointer;
  padding: 0.75rem 0;
  font-weight: 600;
}

.config-group > :deep(.k-schema-header) {
  font-size: 0.9375rem;
}
</style>
