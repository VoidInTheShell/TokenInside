import { sha256Hex } from "./crypto.ts";

export type NewApiUsageSourceIdentity = {
  id?: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
};

export function hasConflictingProxyMatch(
  existing: { matchedProxyLogId?: string } | undefined,
  incoming: { matchedProxyLogId?: string },
) {
  return Boolean(
    existing?.matchedProxyLogId &&
      incoming.matchedProxyLogId &&
      existing.matchedProxyLogId !== incoming.matchedProxyLogId,
  );
}

export function stableNewApiUsageRecordId(identity: string) {
  return `nur_${sha256Hex(identity)}`;
}

export function sameNewApiUsageSource(
  left: NewApiUsageSourceIdentity,
  right: NewApiUsageSourceIdentity,
) {
  if (left.newapiTokenId !== right.newapiTokenId) return false;

  if (left.newapiRequestId && right.newapiRequestId) {
    return left.newapiRequestId === right.newapiRequestId;
  }
  if (left.newapiLogId && right.newapiLogId) {
    return left.newapiLogId === right.newapiLogId;
  }
  return Boolean(left.id && right.id && left.id === right.id);
}

export function newApiUsageIdentityLockKeys(source: NewApiUsageSourceIdentity) {
  const tokenId = source.newapiTokenId ?? "__missing_token__";
  const keys: string[] = [];
  if (source.newapiRequestId) {
    keys.push(`newapi_usage:${tokenId}:request:${source.newapiRequestId}`);
  }
  if (source.newapiLogId) {
    keys.push(`newapi_usage:${tokenId}:log:${source.newapiLogId}`);
  }
  if (!keys.length && source.id) {
    keys.push(`newapi_usage:${tokenId}:id:${source.id}`);
  }
  return keys.sort();
}
