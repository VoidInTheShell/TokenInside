export type AdminUserSortKey =
  | "latestActivity"
  | "name"
  | "department"
  | "status"
  | "role"
  | "packageQuota"
  | "remainingQuota"
  | "quotaConsumed"
  | "totalTokens"
  | "requestCount";

export type AdminDirectoryQuery = {
  search?: string;
  departmentId?: string;
  status?: string;
  role?: string;
  sortBy?: AdminUserSortKey;
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type AdminDirectoryRow = {
  id: string;
  name?: string;
  openId: string;
  departmentId?: string;
  departmentName?: string;
  status?: string;
  role?: string;
  packageQuota?: number;
  remainingQuota?: number;
  quotaConsumed?: number;
  totalTokens?: number;
  requestCount?: number;
  latestActivityAt?: string;
  latestRequestUpdatedAt?: string;
  updatedAt?: string;
};

function selected(value?: string) {
  const normalized = value?.trim();
  return normalized && normalized !== "__all__" ? normalized : undefined;
}

export function filterAdminDirectoryRows<T extends AdminDirectoryRow>(
  rows: T[],
  query: AdminDirectoryQuery,
) {
  const search = selected(query.search)?.toLowerCase();
  const departmentId = selected(query.departmentId);
  const status = selected(query.status);
  const role = selected(query.role);
  return rows.filter((row) => {
    if (departmentId && row.departmentId !== departmentId) return false;
    if (status && row.status !== status) return false;
    if (role && row.role !== role) return false;
    if (!search) return true;
    return [row.name, row.openId, row.departmentId, row.departmentName, row.status, row.role]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search));
  });
}

export function sortAdminDirectoryRows<T extends AdminDirectoryRow>(
  rows: T[],
  sortBy: AdminUserSortKey,
  sortOrder: "asc" | "desc",
) {
  const value = (row: T): string | number => {
    switch (sortBy) {
      case "name":
        return row.name ?? row.openId;
      case "department":
        return row.departmentName ?? row.departmentId ?? "";
      case "status":
        return row.status ?? "";
      case "role":
        return row.role ?? "";
      case "packageQuota":
        return row.packageQuota ?? 0;
      case "remainingQuota":
        return row.remainingQuota ?? 0;
      case "quotaConsumed":
        return row.quotaConsumed ?? 0;
      case "totalTokens":
        return row.totalTokens ?? 0;
      case "requestCount":
        return row.requestCount ?? 0;
      default:
        return row.latestActivityAt ?? row.latestRequestUpdatedAt ?? row.updatedAt ?? "";
    }
  };
  const direction = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const compared =
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), "zh-CN");
    return compared * direction || left.id.localeCompare(right.id);
  });
}

export function queryAdminDirectory<T extends AdminDirectoryRow>(input: {
  rows: T[];
  query: AdminDirectoryQuery;
  defaultSortBy: AdminUserSortKey;
  defaultLimit?: number;
}) {
  const sortBy = input.query.sortBy ?? input.defaultSortBy;
  const sortOrder = input.query.sortOrder ?? "desc";
  const filtered = filterAdminDirectoryRows(input.rows, input.query);
  const sorted = sortAdminDirectoryRows(filtered, sortBy, sortOrder);
  const limit = Math.min(Math.max(input.query.limit ?? input.defaultLimit ?? 20, 1), 500);
  const offset = Math.max(input.query.offset ?? 0, 0);
  return {
    rows: sorted.slice(offset, offset + limit),
    total: sorted.length,
    limit,
    offset,
    sortBy,
    sortOrder,
  };
}
