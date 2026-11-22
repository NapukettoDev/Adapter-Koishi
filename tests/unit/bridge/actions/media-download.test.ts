/**
 * media-download.test.ts：远程媒体下载单测（2026-09-08 T3）。
 *
 * prepareOutboundMedia：URL → 本地临时文件替换、失败回退占位文本 + warn、
 * 大小上限（content-length 与流式累计双路径）、空 body、非 2xx、扩展名推断。
 * fetch 用 vi.stubGlobal 打桩（真实 Response 对象，Node 18+ 内建）。
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareOutboundMedia } from "../../../../src/bridge/actions/media/prepare.js";

/** 图片元素工厂。 */
function imageEl(path: string): CanonicalElement {
    return { type: "image", path };
}

/** 构造 fetch Response 桩。 */
function okResponse(bytes: Uint8Array, contentType?: string): Response {
    return new Response(bytes, {
        status: 200,
        headers: contentType !== undefined ? { "content-type": contentType } : {},
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("prepareOutboundMedia", () => {
    it("http(s) URL → 下载到临时文件并替换 path（cleanup 删除目录）", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okResponse(new Uint8Array([1, 2, 3]), "image/png")),
        );
        const warn = vi.fn();
        const result = await prepareOutboundMedia(
            [{ type: "text", text: "前" }, imageEl("https://x/1.png")],
            { logger: { warn } },
        );
        const replaced = result.elements[1];
        expect(replaced?.type).toBe("image");
        if (replaced?.type === "image") {
            expect(replaced.path).toContain("napuketto-send-");
            expect(replaced.path.endsWith(".png")).toBe(true);
            expect(existsSync(replaced.path)).toBe(true);
        }
        expect(warn).not.toHaveBeenCalled();
        await result.cleanup();
        if (replaced?.type === "image") {
            expect(existsSync(replaced.path)).toBe(false);
        }
    });

    it("相同 URL 去重（一次下载复用路径）", async () => {
        const fetchMock = vi.fn(async () => okResponse(new Uint8Array([9]), "image/jpeg"));
        vi.stubGlobal("fetch", fetchMock);
        const result = await prepareOutboundMedia([
            imageEl("https://x/a.jpg"),
            imageEl("https://x/a.jpg"),
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [first, second] = result.elements;
        expect(first).toEqual(second);
        await result.cleanup();
    });

    it("下载失败（网络错误）→ 回退占位文本 + warn，其余元素不受影响", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("ECONNREFUSED");
            }),
        );
        const warn = vi.fn();
        const result = await prepareOutboundMedia(
            [imageEl("https://x/1.png"), { type: "text", text: "文案" }],
            { logger: { warn } },
        );
        expect(result.elements).toEqual([
            { type: "text", text: "[图片: https://x/1.png]" },
            { type: "text", text: "文案" },
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        await result.cleanup();
    });

    it("非 2xx → 回退占位文本", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("nope", { status: 404 })),
        );
        const warn = vi.fn();
        const result = await prepareOutboundMedia([{ type: "voice", path: "https://x/1.ogg" }], {
            logger: { warn },
        });
        expect(result.elements).toEqual([{ type: "text", text: "[语音: https://x/1.ogg]" }]);
        await result.cleanup();
    });

    it("content-length 超上限 → 回退占位文本", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(new Uint8Array([1]), {
                        status: 200,
                        headers: { "content-length": String(10 * 1024 * 1024) },
                    }),
            ),
        );
        const result = await prepareOutboundMedia([imageEl("https://x/big.png")], {
            maxBytes: 1024,
        });
        expect(result.elements[0]).toEqual({ type: "text", text: "[图片: https://x/big.png]" });
        await result.cleanup();
    });

    it("多块响应流式超限，失败后只留下同一次发送的成功文件", async () => {
        const body = new ReadableStream<Uint8Array>({
            start(stream) {
                stream.enqueue(new Uint8Array(768));
                stream.enqueue(new Uint8Array(768));
                stream.close();
            },
        });
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(okResponse(new Uint8Array([7])))
                .mockResolvedValueOnce(new Response(body)),
        );
        const result = await prepareOutboundMedia(
            [imageEl("https://x/small.png"), imageEl("https://x/stream.png")],
            { maxBytes: 1024 },
        );
        const [accepted, rejected] = result.elements;
        if (accepted?.type !== "image") throw new Error("缺少成功下载的图片");
        expect(rejected).toEqual({ type: "text", text: "[图片: https://x/stream.png]" });
        const directory = dirname(accepted.path);
        expect(await readdir(directory)).toEqual([basename(accepted.path)]);
        await result.cleanup();
        expect(existsSync(directory)).toBe(false);
    });

    it("公网策略在已发布包缺少严格入口时拒绝下载，禁止兼容回退", async () => {
        const fetch = vi.fn();
        const warn = vi.fn();
        vi.stubGlobal("fetch", fetch);
        const result = await prepareOutboundMedia([imageEl("http://127.0.0.1/image.png")], {
            remoteMediaPolicy: "public-only",
            logger: { warn },
        });
        expect(result.elements[0]?.type).toBe("text");
        expect(warn).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        await result.cleanup();
    });

    it("空 body / 空 content → 回退占位文本", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okResponse(new Uint8Array(0), "image/png")),
        );
        const result = await prepareOutboundMedia([imageEl("https://x/empty.png")]);
        expect(result.elements[0]).toEqual({ type: "text", text: "[图片: https://x/empty.png]" });
        await result.cleanup();
    });

    it("无远程媒体时零 IO（不建临时目录）", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        const elements: CanonicalElement[] = [
            { type: "text", text: "hi" },
            imageEl("C:/local/1.png"),
        ];
        const result = await prepareOutboundMedia(elements);
        expect(result.elements).toEqual(elements);
        expect(fetchMock).not.toHaveBeenCalled();
        await result.cleanup();
    });

    it("扩展名推断：魔数和 URL 未提供类型时使用 .bin", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okResponse(new Uint8Array([1]))),
        );
        const result = await prepareOutboundMedia([imageEl("https://x/no-ext/icon")]);
        const el = result.elements[0];
        if (el?.type === "image") {
            expect(el.path).toContain(`${tmpdir()}`.slice(0, 3));
            expect(el.path.endsWith(".bin")).toBe(true);
        }
        await result.cleanup();
    });

    it("兼容入口在每次跳转前检查目标，并允许本机媒体服务", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "http://169.254.0.2/img" },
                }),
            )
            .mockResolvedValueOnce(
                okResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 0]), "image/jpeg"),
            );
        vi.stubGlobal("fetch", fetch);
        const result = await prepareOutboundMedia([
            imageEl("http://127.0.0.1/rejected.jpg"),
            imageEl("http://127.0.0.1/allowed"),
        ]);
        expect(result.elements[0]?.type).toBe("text");
        expect(result.elements[1]).toMatchObject({
            type: "image",
            path: expect.stringMatching(/\.jpg$/),
        });
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            "http://127.0.0.1/rejected.jpg",
            "http://127.0.0.1/allowed",
        ]);
        await result.cleanup();
    });
});
