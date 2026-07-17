import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requireSessionSecret } from "@/lib/config";

function keyFor(context: string, purpose = "quota-credential") {
  return createHash("sha256")
    .update(requireSessionSecret(), "utf8")
    .update(`\0tokeninside-${purpose}\0`, "utf8")
    .update(context, "utf8")
    .digest();
}

export function sealQuotaCredential(value: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(context), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function openQuotaCredential(value: string, context: string) {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("invalid credential envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(context),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function sealAppSecret(value: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(context, "app-secret"), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function openAppSecret(value: string, context: string) {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("invalid secret envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFor(context, "app-secret"),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
