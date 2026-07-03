import { after, NextResponse } from "next/server";
import { nowIso } from "@/lib/crypto";
import {
  decryptFeishuEventPayload,
  hasFeishuEventVerificationToken,
  verifyFeishuEventSignature,
  verifyFeishuEventVerificationToken,
} from "@/lib/feishu";
import { sha256Hex } from "@/lib/crypto";
import { provisionTokenForRequest } from "@/lib/provisioning";
import {
  addFeishuEvent,
  findTokenRequestById,
  findTokenRequestByInstance,
  getFeishuEventByUuid,
  updateTokenRequest,
} from "@/lib/store";
import type { TokenRequest } from "@/lib/types";

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

function nestedUnknown(source: unknown, path: string[]) {
  let cursor = source;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstString(source: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = nestedValue(source, path);
    if (value) return value;
  }
  return undefined;
}

function normalizedActionValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed;
  } catch {
    return value;
  }
}

function parseRawFeishuPayload(rawBody: string, contentType?: string | null) {
  try {
    return JSON.parse(rawBody) as FeishuEventPayload;
  } catch (jsonError) {
    const canTryForm =
      contentType?.includes("application/x-www-form-urlencoded") ||
      rawBody.includes("=");
    if (!canTryForm) throw jsonError;

    const params = new URLSearchParams(rawBody);
    const jsonCandidate =
      params.get("payload") ??
      params.get("event") ??
      params.get("data") ??
      params.get("body");
    if (jsonCandidate) {
      try {
        return JSON.parse(jsonCandidate) as FeishuEventPayload;
      } catch {
        // Fall back to key/value extraction below.
      }
    }

    const entries = Object.fromEntries(params.entries()) as FeishuEventPayload;
    if (Object.keys(entries).length > 0) return entries;
    throw jsonError;
  }
}

function parseFeishuPayloadWrapper(wrapper: FeishuEventPayload) {
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

function extractCardActionEvent(payload: FeishuEventPayload) {
  const actionValue = normalizedActionValue(
    nestedUnknown(payload, ["event", "action", "value"]) ??
    nestedUnknown(payload, ["event", "action", "values"]) ??
    nestedUnknown(payload, ["event", "action"]) ??
    nestedUnknown(payload, ["action", "value"]) ??
    nestedUnknown(payload, ["action", "values"]) ??
    nestedUnknown(payload, ["action_value"]) ??
    nestedUnknown(payload, ["action"]),
  );
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
  const operatorOpenId = firstString(payload, [
    ["event", "operator", "open_id"],
    ["event", "operator", "operator_id", "open_id"],
    ["event", "operator_id", "open_id"],
    ["event", "open_id"],
    ["operator", "open_id"],
    ["operator", "operator_id", "open_id"],
    ["operator_id", "open_id"],
    ["open_id"],
  ]);
  const messageId = firstString(payload, [
    ["event", "message_id"],
    ["event", "context", "open_message_id"],
    ["event", "open_message_id"],
    ["context", "open_message_id"],
    ["message_id"],
    ["open_message_id"],
  ]);
  const cardRequestId = firstString(actionValue, [
    ["requestId"],
    ["request_id"],
    ["card_request_id"],
  ]);
  const cardAction = firstString(actionValue, [["action"], ["cardAction"], ["card_action"]]);
  const nonce = firstString(actionValue, [["nonce"], ["approvalNonce"], ["approval_nonce"]]);

  return {
    eventUuid,
    eventType,
    operatorOpenId,
    messageId,
    cardRequestId,
    cardAction,
    nonce,
  };
}

function cardToast(content: string, type: "success" | "error" = "success") {
  return NextResponse.json({ toast: { type, content } });
}

function rawPreview(rawBody: string) {
  return rawBody
    .slice(0, 1000)
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("app_secret"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/([?&]token=)[^&]+/gi, "$1[redacted]")
    .replace(/(^|&)token=[^&]+/gi, "$1token=[redacted]");
}

async function recordInvalidFeishuPayload(input: {
  rawBody: string;
  request: Request;
  stage: "raw_parse" | "payload_parse";
  wrapper?: FeishuEventPayload;
}) {
  await addFeishuEventBestEffort({
    eventUuid: `invalid-${sha256Hex(`${input.stage}:${input.rawBody}`).slice(0, 32)}`,
    eventType: "invalid_payload",
    processingStatus: "failed",
    payloadJson: {
      stage: input.stage,
      rawLength: input.rawBody.length,
      rawPreview: rawPreview(input.rawBody),
      contentType: input.request.headers.get("content-type"),
      userAgent: input.request.headers.get("user-agent"),
      wrapperKeys: input.wrapper ? Object.keys(input.wrapper) : undefined,
      hasEncrypt: Boolean(input.wrapper?.encrypt),
      encryptLength:
        typeof input.wrapper?.encrypt === "string" ? input.wrapper.encrypt.length : undefined,
    },
    errorMessage: "Invalid Feishu event payload",
  });
  return cardToast("审批回调格式无法识别，已记录", "error");
}

async function addFeishuEventBestEffort(event: Parameters<typeof addFeishuEvent>[0]) {
  try {
    await addFeishuEvent(event);
  } catch (err) {
    console.error("Failed to record Feishu event", err);
  }
}

function payloadVerificationToken(payload: FeishuEventPayload) {
  return (
    payload.token ??
    firstString(payload, [
      ["event", "token"],
      ["header", "token"],
    ])
  );
}

function isCardActionEventType(eventType?: string) {
  return eventType === "card.action.trigger" || eventType === "card.action.trigger_v1";
}

function scheduleTokenProvisionAfterResponse(input: {
  request: TokenRequest;
  eventUuid: string;
  eventType?: string;
  cardRequestId: string;
  cardAction: string;
  operatorOpenId: string;
  messageId?: string;
}) {
  after(async () => {
    try {
      await provisionTokenForRequest(input.request);
    } catch (err) {
      await addFeishuEventBestEffort({
        eventUuid: `${input.eventUuid}:provision`,
        eventType: input.eventType,
        cardRequestId: input.cardRequestId,
        cardAction: input.cardAction,
        operatorOpenId: input.operatorOpenId,
        messageId: input.messageId,
        processingStatus: "failed",
        payloadJson: {
          sourceEventUuid: input.eventUuid,
          tokenRequestId: input.request.id,
          source: "card_action_after_response_provisioning",
        },
        errorMessage: err instanceof Error ? err.message : "NewAPI token provisioning failed",
      });
    }
  });
}

async function handleCardActionEvent(input: {
  encrypted: boolean;
  payload: FeishuEventPayload;
  eventUuid: string;
  eventType?: string;
  operatorOpenId?: string;
  messageId?: string;
  cardRequestId?: string;
  cardAction?: string;
  nonce?: string;
}) {
  const {
    encrypted,
    payload,
    eventUuid,
    eventType,
    operatorOpenId,
    messageId,
    cardRequestId,
    cardAction,
    nonce,
  } = input;

  if (!cardRequestId || !cardAction || !operatorOpenId || !nonce) {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: "Missing card action requestId, action, operator open_id or nonce",
    });
    return cardToast("审批卡片参数不完整", "error");
  }

  const tokenRequest = await findTokenRequestById(cardRequestId);
  if (!tokenRequest) {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: "Token request not found for card action",
    });
    return cardToast("申请单不存在或已失效", "error");
  }

  const expectedNonceHash = tokenRequest.approvalActionNonceHash;
  if (!expectedNonceHash || sha256Hex(nonce) !== expectedNonceHash) {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "failed",
      payloadJson: { encrypted, payload },
      errorMessage: "Invalid card action nonce",
    });
    return cardToast("审批卡片校验失败", "error");
  }

  if (operatorOpenId !== tokenRequest.approvalTargetOpenId) {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: "Card action operator is not the approval target",
    });
    return cardToast("当前用户无权审批此申请", "error");
  }

  if (tokenRequest.status !== "pending_card_approval") {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: `Token request status is ${tokenRequest.status}`,
    });
    return cardToast("该申请已处理", "success");
  }

  const normalizedAction = cardAction.toLowerCase();
  const operatedAt = nowIso();
  if (normalizedAction === "approve" || normalizedAction === "approved") {
    const approved = await updateTokenRequest(tokenRequest.id, {
      status: "approved",
      approvalOperatorOpenId: operatorOpenId,
      approvalOperatedAt: operatedAt,
    });
    scheduleTokenProvisionAfterResponse({
      request: approved ?? {
        ...tokenRequest,
        status: "approved",
        approvalOperatorOpenId: operatorOpenId,
        approvalOperatedAt: operatedAt,
      },
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
    });
  } else if (normalizedAction === "reject" || normalizedAction === "rejected") {
    await updateTokenRequest(tokenRequest.id, {
      status: "rejected",
      approvalOperatorOpenId: operatorOpenId,
      approvalOperatedAt: operatedAt,
    });
  } else {
    await addFeishuEvent({
      eventUuid,
      eventType,
      cardRequestId,
      cardAction,
      operatorOpenId,
      messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: `Unsupported card action ${cardAction}`,
    });
    return cardToast("不支持的审批动作", "error");
  }

  await addFeishuEvent({
    eventUuid,
    eventType,
    cardRequestId,
    cardAction,
    operatorOpenId,
    messageId,
    processingStatus: "processed",
    payloadJson: { encrypted, payload },
  });

  return cardToast(normalizedAction.startsWith("approve") ? "已通过" : "已拒绝");
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  let payload: FeishuEventPayload;
  let encrypted = false;
  let wrapper: FeishuEventPayload;
  try {
    wrapper = parseRawFeishuPayload(rawBody, request.headers.get("content-type"));
  } catch {
    return recordInvalidFeishuPayload({ rawBody, request, stage: "raw_parse" });
  }

  const signatureOk = verifyFeishuEventSignature({
    timestamp: request.headers.get("x-lark-request-timestamp"),
    nonce: request.headers.get("x-lark-request-nonce"),
    signature: request.headers.get("x-lark-signature"),
    rawBody,
  });
  try {
    const parsed = parseFeishuPayloadWrapper(wrapper);
    payload = parsed.payload;
    encrypted = parsed.encrypted;
  } catch {
    return recordInvalidFeishuPayload({
      rawBody,
      request,
      stage: "payload_parse",
      wrapper,
    });
  }

  const wrapperTokenOk =
    !wrapper.encrypt &&
    hasFeishuEventVerificationToken() &&
    verifyFeishuEventVerificationToken(payloadVerificationToken(wrapper));
  const payloadTokenOk = verifyFeishuEventVerificationToken(payloadVerificationToken(payload));
  const { eventUuid, eventType, instanceCode, approvalStatus } =
    extractApprovalEvent(payload);
  const cardActionEvent = extractCardActionEvent(payload);
  const isCardAction =
    isCardActionEventType(eventType) ||
    isCardActionEventType(cardActionEvent.eventType) ||
    Boolean(cardActionEvent.cardRequestId);

  if (!signatureOk && !wrapperTokenOk && !payloadTokenOk) {
    if (isCardAction) {
      await addFeishuEventBestEffort({
        eventUuid,
        eventType: eventType ?? cardActionEvent.eventType,
        cardRequestId: cardActionEvent.cardRequestId,
        cardAction: cardActionEvent.cardAction,
        operatorOpenId: cardActionEvent.operatorOpenId,
        messageId: cardActionEvent.messageId,
        processingStatus: "failed",
        payloadJson: { encrypted, payload },
        errorMessage: "Invalid Feishu card callback signature or verification token",
      });
      return cardToast("审批回调校验失败", "error");
    }
    return NextResponse.json({ error: "Invalid Feishu event signature" }, { status: 401 });
  }

  if (payload.challenge) {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const existingEvent = await getFeishuEventByUuid(eventUuid);
  if (
    existingEvent &&
    ["processed", "ignored"].includes(existingEvent.processingStatus)
  ) {
    if (isCardAction) {
      return cardToast("该申请已处理", "success");
    }
    return NextResponse.json({ ok: true, duplicate: true });
  }

  try {
    if (
      isCardActionEventType(eventType) ||
      isCardActionEventType(cardActionEvent.eventType) ||
      cardActionEvent.cardRequestId
    ) {
      try {
        return await handleCardActionEvent({
          encrypted,
          payload,
          ...cardActionEvent,
        });
      } catch (err) {
        await addFeishuEventBestEffort({
          eventUuid,
          eventType: eventType ?? cardActionEvent.eventType,
          cardRequestId: cardActionEvent.cardRequestId,
          cardAction: cardActionEvent.cardAction,
          operatorOpenId: cardActionEvent.operatorOpenId,
          messageId: cardActionEvent.messageId,
          processingStatus: "failed",
          payloadJson: { encrypted, payload },
          errorMessage: err instanceof Error ? err.message : "Card action processing failed",
        });
        return cardToast("审批处理失败，请到管理后台处理", "error");
      }
    }

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
