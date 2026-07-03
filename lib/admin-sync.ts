import {
  getFeishuContactUserByOpenId,
  getFeishuDepartmentById,
} from "@/lib/feishu";
import {
  getAdminScopeForUser,
  syncDepartmentSupervisorAdminScope,
  upsertFeishuUser,
} from "@/lib/store";
import type { FeishuUser } from "@/lib/types";

function firstDepartmentId(value?: string[]) {
  return value?.find((item) => item.length > 0);
}

export async function hydrateUserDepartment<T extends FeishuUser | null>(user: T) {
  if (!user || user.departmentId) return user;
  try {
    const contactUser = await getFeishuContactUserByOpenId(user.openId);
    const departmentId = firstDepartmentId(contactUser.department_ids);
    if (!departmentId) return user;
    return upsertFeishuUser({
      tenantKey: user.tenantKey,
      openId: user.openId,
      unionId: user.unionId,
      feishuUserIdFromFeishu: user.feishuUserIdFromFeishu,
      name: user.name,
      avatarUrl: user.avatarUrl,
      departmentId,
    }) as Promise<NonNullable<T>>;
  } catch {
    return user;
  }
}

export async function syncDepartmentSupervisorScopeForUser(user: FeishuUser) {
  if (!user.departmentId) return null;
  try {
    const department = await getFeishuDepartmentById(user.departmentId);
    const departmentId =
      department.open_department_id ?? department.department_id ?? user.departmentId;
    const isSupervisor = department.leader_user_id === user.openId;
    return syncDepartmentSupervisorAdminScope({
      feishuUserId: user.id,
      departmentId,
      isSupervisor,
    });
  } catch {
    return null;
  }
}

export async function getEffectiveAdminScopeForUser(user: FeishuUser) {
  const storedScope = await getAdminScopeForUser(user.id);
  if (storedScope) return storedScope;
  return syncDepartmentSupervisorScopeForUser(user);
}
