import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { publishPackageVersion } from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    return NextResponse.json({
      version: await publishPackageVersion({ scope: auth.scope, versionId: id }),
    });
  } catch (error) {
    return packageRouteError(error);
  }
}
