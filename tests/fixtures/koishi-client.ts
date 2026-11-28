import { vi } from "vitest";
import { defineComponent, h, reactive } from "vue";

export const store = reactive<Record<string, unknown>>({});
export const send = vi.fn<(event: string, data: unknown) => Promise<unknown> | undefined>();
export const SchemaBase = {
    // biome-ignore lint/style/useNamingConvention: 匹配官方 Console 的 SchemaBase API。
    Schema: defineComponent({
        props: { schema: Object },
        setup(props) {
            return () => h("div", { "data-schema": JSON.stringify(props.schema) });
        },
    }),
};
