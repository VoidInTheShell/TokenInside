import { NextResponse } from "next/server";
import { requireAdminScope } from "@/lib/admin";
import { getPackageDefinition } from "@/lib/package-repository";
import { packageRouteError } from "@/lib/package-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  try {
    const { id } = await params;
    return NextResponse.json(
      await getPackageDefinition({ scope: auth.scope, definitionId: id }),
    );
  } catch (error) {
    return packageRouteError(error);
  }
}
