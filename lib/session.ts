import { cookies } from "next/headers";
import { hmacSha256Base64Url, safeEqual } from "@/lib/crypto";
import { requireSessionSecret } from "@/lib/config";
import { getUserById } from "@/lib/store";

export const sessionCookieName = "ti_session";

export type SessionPayload = {
  userId: string;
  tenantKey: string;
  openId: string;
  exp: number;
};

function encodePayload(payload: SessionPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(value: string): SessionPayload {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as SessionPayload;
}

export function createSessionToken(payload: Omit<SessionPayload, "exp">) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 8;
  const body = encodePayload({ ...payload, exp });
  const signature = hmacSha256Base64Url(requireSessionSecret(), body);
  return `${body}.${signature}`;
}

export function verifySessionToken(token?: string | null) {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  let expected: string;
  try {
    expected = hmacSha256Base64Url(requireSessionSecret(), body);
  } catch {
    return null;
  }
  if (!safeEqual(signature, expected)) return null;
  const payload = decodePayload(body);
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function getCurrentUser() {
  const payload = await getCurrentSessionIdentity();
  if (!payload) return null;
  return getUserById(payload.userId);
}

export async function getCurrentSessionIdentity() {
  const cookieStore = await cookies();
  const payload = verifySessionToken(cookieStore.get(sessionCookieName)?.value);
  return payload;
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}
