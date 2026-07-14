import { NextResponse } from "next/server";
import { packageErrorResponse } from "./package-errors.ts";

export function packageRouteError(error: unknown) {
  const response = packageErrorResponse(error);
  return NextResponse.json(response.body, { status: response.status });
}

export function positivePageValue(value: string | null, fallback: number, max = 100) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function nonNegativePageValue(value: string | null, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
