export const DEFAULT_REMOTE_MEDIA_POLICY = "compatible";
export const DEFAULT_LOCAL_FILE_POLICY = "legacy";

export interface OutboundMediaPolicy {
    remoteMediaPolicy?: "compatible" | "public-only";
    localFilePolicy?: "legacy" | "allowlist";
    localMediaRoots?: string[];
}
