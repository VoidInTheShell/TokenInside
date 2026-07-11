function normalizeDepartmentId(value?: string) {
  const departmentId = value?.trim();
  if (!departmentId || departmentId === "system-admin-fallback") return undefined;
  return departmentId;
}

export function selectInitialApprovalDepartmentId(
  knownDepartmentId?: string,
  contactDepartmentIds: string[] = [],
) {
  const known = normalizeDepartmentId(knownDepartmentId);
  if (known) return known;
  return contactDepartmentIds.map(normalizeDepartmentId).find(Boolean);
}
