import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listQuotaOperations } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Feishu OAuth session required" }, { status: 401 });
  }
  const operations = (await listQuotaOperations({ feishuUserId: user.id, limit: 20 })).map(
    ({ credentialCiphertext: _credentialCiphertext, ...operation }) => ({
      ...operation,
      credentialPendingDelivery: Boolean(
        _credentialCiphertext && !operation.credentialDeliveredAt,
      ),
    }),
  );
  return NextResponse.json({ operations });
}
