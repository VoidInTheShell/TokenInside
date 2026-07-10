export type NewApiUsageSourceIdentity = {
  id?: string;
  newapiLogId?: string;
  newapiRequestId?: string;
  newapiTokenId?: string;
};

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
