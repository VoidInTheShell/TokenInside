import {
  getFeishuContactUserByOpenId,
  getFeishuDepartmentById,
  getFeishuDepartmentNameById,
} from "@/lib/feishu";
import {
  getAdminScopeForKnownUser,
  syncDepartmentSupervisorAdminScope,
  upsertFeishuUser,
} from "@/lib/store";
import type { FeishuUser } from "@/lib/types";

function firstDepartmentId(value?: string[]) {
  return value?.find((item) => item.length > 0);
}

function isInactiveUser(user: FeishuUser) {
  return Boolean(user.status && user.status !== "active");
}

export async function hydrateUserDepartment<T extends FeishuUser | null>(user: T) {
  if (!user) return user;
  if (user.departmentId && user.departmentName) return user;
  try {
    let departmentId = user.departmentId;
    if (!departmentId) {
      const contactUser = await getFeishuContactUserByOpenId(user.openId);
      departmentId = firstDepartmentId(contactUser.department_ids);
    }
    if (!departmentId) return user;

    let departmentName = user.departmentName;
    if (!departmentName) {
      try {
        departmentName = await getFeishuDepartmentNameById(departmentId);
      } catch {
        departmentName = undefined;
      }
    }
    if (departmentId === user.departmentId && departmentName === user.departmentName) return user;

    return upsertFeishuUser({
      tenantKey: user.tenantKey,
      openId: user.openId,
      unionId: user.unionId,
      feishuUserIdFromFeishu: user.feishuUserIdFromFeishu,
      name: user.name,
      avatarUrl: user.avatarUrl,
      departmentId,
      departmentName,
    }) as Promise<NonNullable<T>>;
  } catch {
    return user;
  }
}

export async function syncDepartmentSupervisorScopeForUser(user: FeishuUser) {
  if (isInactiveUser(user)) return null;
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
  if (isInactiveUser(user)) return null;
  const storedScope = await getAdminScopeForKnownUser(user);
  if (storedScope) return storedScope;
  return syncDepartmentSupervisorScopeForUser(user);
}
