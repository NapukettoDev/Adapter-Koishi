import {
    type IpcGroupRequest,
    IpcRespondToGroupRequestParamsSchema,
} from "../runtime/ipc/index.js";
import { IpcError } from "../shared.js";

const PREFIX = "qq-group-request:";

export function groupRequestId({ selfUin, request }: IpcGroupRequest): string {
    return PREFIX + JSON.stringify({ selfUin, request });
}

export function groupRequestResponse(
    id: string,
    invitation: boolean,
    approve: boolean,
    reason?: string,
) {
    if (!id.startsWith(PREFIX)) {
        return undefined;
    }

    let reference: unknown;
    try {
        reference = JSON.parse(id.slice(PREFIX.length));
    } catch {
        throw new IpcError("群请求 ID 无效", "INVALID_PARAM");
    }
    const result = IpcRespondToGroupRequestParamsSchema.safeParse({
        ...(typeof reference === "object" && reference !== null ? reference : {}),
        approve,
        ...(reason === undefined ? {} : { reason }),
    });
    if (!result.success || (result.data.request.kind === "invitation") !== invitation) {
        throw new IpcError("群请求 ID 与审批方法不匹配", "INVALID_PARAM");
    }
    return result.data;
}
