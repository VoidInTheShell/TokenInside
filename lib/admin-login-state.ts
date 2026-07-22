import type { WorkspaceAccess } from "@/lib/workspace-access";

export function adminFirstLoginNeedsProvisioning(input: {
  authenticated?: boolean;
  hasAdminScope: boolean;
  hasActiveToken: boolean;
  workspaceAccess?: WorkspaceAccess;
}) {
  return Boolean(
    input.authenticated &&
      input.hasAdminScope &&
      !input.hasActiveToken &&
      input.workspaceAccess !== "disabled",
  );
}
