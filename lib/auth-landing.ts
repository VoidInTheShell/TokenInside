export type AuthLandingScope = {
  scopeType: "global" | "department";
  source?: "manual" | "department_supervisor" | "environment";
  role?: "root";
} | null;

export function defaultPostLoginPath(scope: AuthLandingScope) {
  void scope;
  return "/";
}
