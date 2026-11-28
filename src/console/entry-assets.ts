import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const CLIENT_FILES = ["index.js", "index.css"] as const;

function readAssets(dir: string) {
    return CLIENT_FILES.map((name) => {
        try {
            return { name, bytes: readFileSync(join(dir, name)) };
        } catch (cause) {
            throw new Error(`[napuketto] 无法读取控制台产物 dist/${name}`, { cause });
        }
    });
}

/** Console 只服务其根目录下或包含 node_modules 的入口路径。 */
export function prepareConsoleAssets(source: string, baseDir: string): string {
    const assets = readAssets(source);
    if (source.split(sep).includes("node_modules")) return source;

    // 每个文件的定长摘要使组合签名保留文件边界，回滚也能重用相同内容。
    const hash = createHash("sha256");
    for (const { bytes } of assets) hash.update(createHash("sha256").update(bytes).digest());
    const parent = resolve(
        baseDir,
        "data/napuketto-console/node_modules/koishi-plugin-adapter-napuketto",
    );
    const version = join(parent, hash.digest("hex"));
    const dist = join(version, "dist");
    function verifyPublished(): string {
        const published = readAssets(dist);
        if (published.some(({ bytes }, index) => !assets[index]?.bytes.equals(bytes))) {
            throw new Error("[napuketto] 控制台产物缓存内容不一致");
        }
        return dist;
    }
    if (existsSync(version)) return verifyPublished();

    mkdirSync(parent, { recursive: true });
    const staging = mkdtempSync(join(parent, ".staging-"));
    try {
        const stagingDist = join(staging, "dist");
        mkdirSync(stagingDist);
        for (const { name, bytes } of assets) writeFileSync(join(stagingDist, name), bytes);
        try {
            renameSync(staging, version);
        } catch (error) {
            // 另一进程可能已发布相同快照。只有完整且内容相同的目录才可复用。
            if (!existsSync(version)) throw error;
            return verifyPublished();
        }
        return dist;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
