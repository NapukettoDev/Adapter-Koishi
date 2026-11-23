import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IpcError } from "../../../shared.js";

const ABANDONED_AGE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_RESULT_GRACE_MS = 120_000;
const DIRECTORY_NAME = /^send-([1-9][0-9]{0,9})-[a-z0-9]{6}$/i;

async function removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

function processExited(pid: number): boolean {
    if (pid > 0x7fffffff || pid === process.pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
}

async function reapAbandoned(root: string): Promise<void> {
    const oldest = Date.now() - ABANDONED_AGE_MS;
    for (const entry of await readdir(root, { withFileTypes: true })) {
        const pid = DIRECTORY_NAME.exec(entry.name)?.[1];
        if (!entry.isDirectory() || pid === undefined || !processExited(Number(pid))) {
            continue;
        }
        const path = join(root, entry.name);
        const info = await lstat(path).catch(() => undefined);
        if (info?.isDirectory() && info.mtimeMs < oldest) {
            await removeDirectory(path);
        }
    }
}

export class MediaWorkspace {
    private directory?: string;

    constructor(
        private readonly root: string | undefined,
        private readonly warn: (() => void) | undefined,
    ) {}

    async file(extension: string): Promise<string> {
        if (this.directory === undefined) {
            const root = this.root;
            if (root !== undefined) {
                await mkdir(root, { recursive: true, mode: 0o700 });
                const info = await lstat(root);
                if (!info.isDirectory() || (process.platform !== "win32" && info.mode & 0o077)) {
                    throw new IpcError("出站媒体临时根必须是私有普通目录", "INVALID_STATE");
                }
                await reapAbandoned(root).catch(() => this.warn?.());
            }
            const prefix = root === undefined ? "napuketto-send-" : `send-${process.pid}-`;
            this.directory = await mkdtemp(join(root ?? tmpdir(), prefix));
        }
        return join(this.directory, `${randomUUID()}${extension}`);
    }

    owns(path: string): boolean {
        return dirname(path) === this.directory;
    }

    async cleanup(uncertain = false): Promise<void> {
        const directory = this.directory;
        if (directory === undefined) {
            return;
        }
        delete this.directory;
        const remove = () => removeDirectory(directory).catch(() => this.warn?.());
        if (uncertain) {
            // 本地 IPC 超时或断开没有取消已提交的宿主动作。
            setTimeout(() => {
                void remove();
            }, UNKNOWN_RESULT_GRACE_MS).unref();
        } else {
            await remove();
        }
    }
}
