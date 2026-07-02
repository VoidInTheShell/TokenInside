import { NextResponse } from "next/server";
import { verifyFeishuEventSignature } from "@/lib/feishu";
import { provisionTokenForRequest } from "@/lib/provisioning";
import {
  addFeishuEvent,
  findTokenRequestByInstance,
  updateTokenRequest,
} from "@/lib/store";

export const runtime = "nodejs";

type FeishuEventPayload = {
  challenge?: string;
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
  };
  event?: Record<string, unknown>;
  type?: string;
  token?: string;
};

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function extractApprovalEvent(payload: FeishuEventPayload) {
  const event = payload.event ?? {};
  const instanceCode =
    stringValue(event.instance_code) ??
    stringValue(event.instanceCode) ??
    stringValue(event.approval_instance_code);
  const approvalStatus =
    stringValue(event.status) ??
    stringValue(event.approval_status) ??
    stringValue(event.approvalStatus);
  return { instanceCode, approvalStatus };
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
  try {
    payload = JSON.parse(rawBody) as FeishuEventPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (payload.challenge) {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const { instanceCode, approvalStatus } = extractApprovalEvent(payload);
  const eventUuid =
    payload.header?.event_id ??
    `${instanceCode ?? "unknown"}:${approvalStatus ?? "unknown"}:${Date.now()}`;

  try {
    if (!instanceCode || !approvalStatus) {
      await addFeishuEvent({
        eventUuid,
        eventType: payload.header?.event_type,
        processingStatus: "ignored",
        payloadJson: payload,
      });
      return NextResponse.json({ ok: true, ignored: true });
    }

    const tokenRequest = await findTokenRequestByInstance(instanceCode);
    if (!tokenRequest) {
      await addFeishuEvent({
        eventUuid,
        eventType: payload.header?.event_type,
        instanceCode,
        approvalStatus,
        processingStatus: "ignored",
        payloadJson: payload,
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
      eventType: payload.header?.event_type,
      instanceCode,
      approvalStatus,
      processingStatus: "processed",
      payloadJson: payload,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    await addFeishuEvent({
      eventUuid,
      eventType: payload.header?.event_type,
      instanceCode,
      approvalStatus,
      processingStatus: "failed",
      payloadJson: payload,
      errorMessage: err instanceof Error ? err.message : "Event processing failed",
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Event processing failed" },
      { status: 500 },
    );
  }
}
