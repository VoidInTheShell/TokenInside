import { NextResponse } from "next/server";

export function newApiReportingFailure(error: unknown, message: string) {
  console.error(
    JSON.stringify({
      event: "tokeninside.newapi_reporting.failed",
      reason: error instanceof Error ? error.name : "unknown_error",
    }),
  );
  return NextResponse.json(
    { error: message, code: "newapi_reporting_unavailable" },
    { status: 502 },
  );
}
