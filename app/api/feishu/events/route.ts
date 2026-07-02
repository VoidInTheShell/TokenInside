import { NextResponse } from "next/server";
import {
  decryptFeishuEventPayload,
  verifyFeishuEventSignature,
  verifyFeishuEventVerificationToken,
} from "@/lib/feishu";
import { sha256Hex } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import {
  addFeishuEvent,
  findTokenRequestByInstance,
  getFeishuEventByUuid,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

type FeishuEventPayload = {
  challenge?: string;
  encrypt?: string;
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
  };
  event?: JsonRecord;
  type?: string;
  token?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function nestedValue(source: unknown, path: string[]) {
  let cursor = source;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return stringValue(cursor);
}

function firstString(source: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = nestedValue(source, path);
    if (value) return value;
  }
  return undefined;
}

function parseJsonPayload(rawBody: string) {
  const wrapper = JSON.parse(rawBody) as FeishuEventPayload;
  if (!wrapper.encrypt) {
    return { payload: wrapper, encrypted: false };
  }

  const decrypted = decryptFeishuEventPayload(wrapper.encrypt);
  return {
    payload: JSON.parse(decrypted) as FeishuEventPayload,
    encrypted: true,
  };
}

function extractApprovalEvent(payload: FeishuEventPayload) {
  const instanceCode = firstString(payload, [
    ["event", "instance_code"],
    ["event", "instanceCode"],
    ["event", "approval_instance_code"],
    ["event", "approval_instance", "instance_code"],
    ["event", "object", "instance_code"],
    ["event", "data", "instance_code"],
  ]);
  const approvalStatus = firstString(payload, [
    ["event", "status"],
    ["event", "approval_status"],
    ["event", "approvalStatus"],
    ["event", "approval_instance", "status"],
    ["event", "object", "status"],
    ["event", "data", "status"],
  ]);
  const eventUuid =
    firstString(payload, [
      ["header", "event_id"],
      ["event", "event_id"],
      ["event", "uuid"],
      ["uuid"],
    ]) ?? sha256Hex(JSON.stringify(payload));
  const eventType = firstString(payload, [
    ["header", "event_type"],
    ["event", "type"],
    ["type"],
  ]);

  return { eventUuid, eventType, instanceCode, approvalStatus };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signatureOk = verifyFeishuEventSignature({
    timestamp: request.headers.get("x-lark-request-timestamp"),
    nonce: request.headers.get("x-lark-request-nonce"),
    signature: request.headers.get("x-lark-signature"),
    rawBody,
  });
  if (!signatureOk) {
    return NextResponse.json({ error: "Invalid Feishu event signature" }, { status: 401 });
  }

  let payload: FeishuEventPayload;
  let encrypted = false;
  try {
    const parsed = parseJsonPayload(rawBody);
    payload = parsed.payload;
    encrypted = parsed.encrypted;
  } catch {
    return NextResponse.json({ error: "Invalid Feishu event payload" }, { status: 400 });
  }

  if (!verifyFeishuEventVerificationToken(payload.token)) {
    return NextResponse.json({ error: "Invalid Feishu event verification token" }, { status: 401 });
  }

  if (payload.challenge) {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const { eventUuid, eventType, instanceCode, approvalStatus } =
    extractApprovalEvent(payload);
  const existingEvent = await getFeishuEventByUuid(eventUuid);
  if (
    existingEvent &&
    ["processed", "ignored"].includes(existingEvent.processingStatus)
  ) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    if (!instanceCode || !approvalStatus) {
      await addFeishuEvent({
        eventUuid,
        eventType,
        processingStatus: "ignored",
        payloadJson: { encrypted, payload },
      });
      return NextResponse.json({ ok: true, ignored: true });
    }

    const tokenRequest = await findTokenRequestByInstance(instanceCode);
    if (!tokenRequest) {
      await addFeishuEvent({
        eventUuid,
        eventType,
        instanceCode,
        approvalStatus,
        processingStatus: "ignored",
        payloadJson: { encrypted, payload },
      });
      return NextResponse.json({ ok: true, ignored: true });
    }

    const normalizedStatus = approvalStatus.toUpperCase();
    if (normalizedStatus === "APPROVED") {
      await updateTokenRequest(tokenRequest.id, { status: "approved" });
      await provisionTokenForRequest({ ...tokenRequest, status: "approved" });
    } else if (["REJECTED", "CANCELED", "CANCELLED"].includes(normalizedStatus)) {
      await updateTokenRequest(tokenRequest.id, {
        status: normalizedStatus === "REJECTED" ? "rejected" : "cancelled",
      });
    }

    await addFeishuEvent({
      eventUuid,
      eventType,
      instanceCode,
      approvalStatus,
      processingStatus: "processed",
      payloadJson: { encrypted, payload },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    await addFeishuEvent({
      eventUuid,
      eventType,
      instanceCode,
      approvalStatus,
      processingStatus: "failed",
      payloadJson: { encrypted, payload },
      errorMessage: err instanceof Error ? err.message : "Event processing failed",
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Event processing failed" },
      { status: 500 },
    );
  }
}
