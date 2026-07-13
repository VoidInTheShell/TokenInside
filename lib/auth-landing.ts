export type AuthLandingScope = {
  scopeType: "global" | "department";
  source?: "manual" | "department_supervisor" | "environment";
  role?: "root";
} | null;

export function defaultPostLoginPath(scope: AuthLandingScope) {
  return scope ? "/admin" : "/";
}

export function shouldRedirectToDefaultAdminPath(input: {
  scope: AuthLandingScope;
  currentPath: string;
  search: string;
}) {
  return (
    defaultPostLoginPath(input.scope) === "/admin" &&
    input.currentPath === "/" &&
    new URLSearchParams(input.search).get("view") !== "user"
  );
}
