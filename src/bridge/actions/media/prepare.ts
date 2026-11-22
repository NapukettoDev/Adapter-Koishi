import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalElement } from "@napuketto/kernel";
import {
    type AcquireMediaOptions,
    acquireMedia,
    type MediaElement,
    type MediaFileFactory,
} from "./acquire.js";
import { enrichVideo, ensureSilk } from "./transcode.js";

const MEDIA_TYPES = {
    image: { mime: "image/", label: "图片", maxBytes: 30 * 1024 * 1024 },
    voice: { mime: "audio/", label: "语音", maxBytes: 30 * 1024 * 1024 },
    video: { mime: "video/", label: "视频", maxBytes: 100 * 1024 * 1024 },
} as const;

class MediaWorkspace {
    private directory?: string;

    async file(extension: string): Promise<string> {
        this.directory ??= await mkdtemp(join(tmpdir(), "napuketto-send-"));
        return join(this.directory, `${randomUUID()}${extension}`);
    }

    async cleanup(): Promise<void> {
        if (this.directory !== undefined) {
            await rm(this.directory, { recursive: true, force: true });
        }
    }
}

function isMedia(element: CanonicalElement): element is MediaElement {
    return element.type === "image" || element.type === "voice" || element.type === "video";
}

async function prepareElement(
    element: MediaElement,
    createFile: MediaFileFactory,
    options: AcquireMediaOptions,
): Promise<CanonicalElement> {
    const prepared = await acquireMedia(element, createFile, MEDIA_TYPES[element.type], options);
    switch (prepared.type) {
        case "voice":
            return {
                ...prepared,
                path: await ensureSilk(prepared.path, createFile, options.logger),
            };
        case "video":
            return prepared.thumbPath === undefined
                ? enrichVideo(prepared, createFile, options.logger)
                : prepared;
        default:
            return prepared;
    }
}

export async function prepareOutboundMedia(
    elements: CanonicalElement[],
    options: AcquireMediaOptions = {},
): Promise<{ elements: CanonicalElement[]; cleanup: () => Promise<void> }> {
    const workspace = new MediaWorkspace();
    const createFile = (extension: string) => workspace.file(extension);
    const prepared: CanonicalElement[] = [];
    const cache = new Map<string, CanonicalElement>();
    const cleanup = async () => {
        await workspace.cleanup().catch(() => options.logger?.warn("无法清理发送媒体的临时目录"));
    };
    try {
        for (const element of elements) {
            if (!isMedia(element)) {
                prepared.push(element);
                continue;
            }
            const key = `${element.type}:${element.path}`;
            const result = cache.get(key) ?? (await prepareElement(element, createFile, options));
            cache.set(key, result);
            prepared.push(result);
        }
        return { elements: prepared, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
