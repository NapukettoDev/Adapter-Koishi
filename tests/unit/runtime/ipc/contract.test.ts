import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { IpcMessageSchema } from "@napuketto/loader";
import { describe, expect, it, vi } from "vitest";
import { NapukettoIpcClient } from "../../../../src/runtime/ipc/index.js";
import { MemoryLinePair } from "../../../helpers/ipc.js";

describe("已发布 loader 的 IPC v1 契约", () => {
    it("随包提供 self-host 和 Windows / Linux x64 stub", async () => {
        const require = createRequire(import.meta.url);
        const dist = dirname(require.resolve("@napuketto/loader"));
        await Promise.all([
            access(join(dist, "host", "self-host.cjs")),
            access(join(dist, "..", "native", "prebuilt", "win32-x64", "QQNT.dll")),
            access(join(dist, "..", "native", "prebuilt", "linux-x64", "libnapuketto_stub.so")),
        ]);
    });

    it("对固定 v1 报文分发状态和事件、解析动作结果并回应心跳", async () => {
        // 固定已部署的报文，避免两端同时从新版 schema 取常量而掩盖破坏性变更。
        const transport = new MemoryLinePair();
        const client = new NapukettoIpcClient(transport);
        const status = vi.fn();
        const event = vi.fn();
        const outbound: string[] = [];
        transport.peer.onLine((line) => outbound.push(line));
        client.on("status", status);
        client.on("event", event);

        client.sendControl({ command: "status" });
        const result = client.request("login.getSelf", undefined, 250);
        transport.peer.write('{"v":1,"type":"status","payload":{"phase":"ready"}}\n');
        transport.peer.write(
            '{"v":1,"type":"event","payload":{"service":"Msg","name":"onRecvMsg","args":[]}}\n',
        );
        transport.peer.write('{"v":1,"type":"ping"}\n');
        transport.peer.write(
            '{"v":1,"type":"result","id":1,"payload":{"ok":true,"value":{"uin":"123"}}}\n',
        );
        try {
            await expect(result).resolves.toEqual({ uin: "123" });
            expect(status).toHaveBeenCalledWith({
                v: 1,
                type: "status",
                payload: { phase: "ready" },
            });
            expect(event).toHaveBeenCalledWith({
                v: 1,
                type: "event",
                payload: { service: "Msg", name: "onRecvMsg", args: [] },
            });
            expect(outbound).toEqual([
                '{"v":1,"type":"control","payload":{"command":"status"}}\n',
                '{"v":1,"type":"action","id":1,"payload":{"action":"login.getSelf"}}\n',
                '{"v":1,"type":"pong"}\n',
            ]);
            for (const line of outbound) {
                expect(IpcMessageSchema.safeParse(JSON.parse(line)).success).toBe(true);
            }
        } finally {
            client.close();
        }
    });
});
