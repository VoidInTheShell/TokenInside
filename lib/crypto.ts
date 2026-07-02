import crypto from "node:crypto";

export function sha256Hex(value: string | Buffer) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Base64Url(secret: string, value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function decryptAes256CbcBase64(input: {
  ciphertextBase64: string;
  keyMaterial: string;
}) {
  const key = crypto.createHash("sha256").update(input.keyMaterial).digest();
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertextBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
