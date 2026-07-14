import { after, NextResponse } from "next/server";
import { getEffectiveAdminScopeForUser } from "@/lib/admin-sync";
import { sha256Hex } from "@/lib/crypto";
import {
  decryptFeishuEventPayload,
  hasFeishuEventVerificationToken,
  verifyFeishuEventSignature,
  verifyFeishuEventVerificationToken,
} from "@/lib/feishu";
import { decidePackageRequest, findPackageRequestById } from "@/lib/package-repository";
import { provisionApprovedPackageRequest } from "@/lib/package-saga";
import { addFeishuEvent, getFeishuEventByUuid, getUserByOpenId } from "@/lib/store";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;
type FeishuPayload = {
  challenge?: string;
  encrypt?: string;
  type?: string;
  token?: string;
  header?: { event_id?: string; event_type?: string; token?: string };
  event?: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nested(source: unknown, path: string[]) {
  let cursor = source;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function firstString(source: unknown, paths: string[][]) {
  for (const path of paths) {
    const value = nested(source, path);
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function normalizedActionValue(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function parseRawPayload(rawBody: string, contentType?: string | null) {
  try { return JSON.parse(rawBody) as FeishuPayload; } catch (jsonError) {
    if (!contentType?.includes("application/x-www-form-urlencoded") && !rawBody.includes("=")) throw jsonError;
    const params = new URLSearchParams(rawBody);
    const candidate = params.get("payload") ?? params.get("event") ?? params.get("data") ?? params.get("body");
    if (candidate) return JSON.parse(candidate) as FeishuPayload;
    const entries = Object.fromEntries(params.entries()) as FeishuPayload;
    if (Object.keys(entries).length) return entries;
    throw jsonError;
  }
}

function parseWrapper(wrapper: FeishuPayload) {
  if (!wrapper.encrypt) return { payload: wrapper, encrypted: false };
  return { payload: JSON.parse(decryptFeishuEventPayload(wrapper.encrypt)) as FeishuPayload, encrypted: true };
}

function extractCardAction(payload: FeishuPayload) {
  const actionValue = normalizedActionValue(
    nested(payload, ["event", "action", "value"]) ??
    nested(payload, ["event", "action", "values"]) ??
    nested(payload, ["event", "action"]) ??
    nested(payload, ["action", "value"]) ??
    nested(payload, ["action"]),
  );
  return {
    eventUuid: firstString(payload, [["header", "event_id"], ["event", "event_id"], ["event", "uuid"], ["uuid"]]) ?? sha256Hex(JSON.stringify(payload)),
    eventType: firstString(payload, [["header", "event_type"], ["event", "type"], ["type"]]),
    operatorOpenId: firstString(payload, [["event", "operator", "open_id"], ["event", "operator", "operator_id", "open_id"], ["event", "operator_id", "open_id"], ["event", "open_id"], ["operator", "open_id"], ["open_id"]]),
    messageId: firstString(payload, [["event", "message_id"], ["event", "context", "open_message_id"], ["event", "open_message_id"], ["message_id"]]),
    requestId: firstString(actionValue, [["requestId"], ["request_id"], ["card_request_id"]]),
    action: firstString(actionValue, [["action"], ["cardAction"], ["card_action"]]),
    nonce: firstString(actionValue, [["nonce"], ["approvalNonce"], ["approval_nonce"]]),
  };
}

function verificationToken(payload: FeishuPayload) {
  return payload.token ?? firstString(payload, [["event", "token"], ["header", "token"]]);
}

function cardToast(content: string, type: "success" | "error" = "success") {
  return NextResponse.json({ toast: { type, content } });
}

async function record(event: Parameters<typeof addFeishuEvent>[0]) {
  try { await addFeishuEvent(event); } catch (error) { console.error("Failed to record Feishu event", error); }
}

function redactedPreview(rawBody: string) {
  return rawBody.slice(0, 1000)
    .replace(/("token"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("app_secret"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2");
}

async function invalidPayload(rawBody: string, request: Request, stage: string) {
  await record({
    eventUuid: `invalid-${sha256Hex(`${stage}:${rawBody}`).slice(0, 32)}`,
    eventType: "invalid_payload",
    processingStatus: "failed",
    payloadJson: { stage, rawLength: rawBody.length, rawPreview: redactedPreview(rawBody), contentType: request.headers.get("content-type") },
    errorMessage: "Invalid Feishu event payload",
  });
  return cardToast("审批回调格式无法识别，已记录", "error");
}

function normalizedDecision(action: string) {
  const value = action.toLowerCase();
  if (value === "approve" || value === "approved") return "approve" as const;
  if (value === "reject" || value === "rejected") return "reject" as const;
  return null;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  let wrapper: FeishuPayload;
  try { wrapper = parseRawPayload(rawBody, request.headers.get("content-type")); }
  catch { return invalidPayload(rawBody, request, "raw_parse"); }

  let payload: FeishuPayload;
  let encrypted = false;
  try {
    const parsed = parseWrapper(wrapper);
    payload = parsed.payload;
    encrypted = parsed.encrypted;
  } catch { return invalidPayload(rawBody, request, "payload_parse"); }

  const signatureOk = verifyFeishuEventSignature({
    timestamp: request.headers.get("x-lark-request-timestamp"),
    nonce: request.headers.get("x-lark-request-nonce"),
    signature: request.headers.get("x-lark-signature"),
    rawBody,
  });
  const wrapperTokenOk = !wrapper.encrypt && hasFeishuEventVerificationToken() && verifyFeishuEventVerificationToken(verificationToken(wrapper));
  const payloadTokenOk = verifyFeishuEventVerificationToken(verificationToken(payload));
  if (!signatureOk && !wrapperTokenOk && !payloadTokenOk) {
    return NextResponse.json({ error: "Invalid Feishu event signature" }, { status: 401 });
  }
  if (payload.challenge) return NextResponse.json({ challenge: payload.challenge });

  const card = extractCardAction(payload);
  const existing = await getFeishuEventByUuid(card.eventUuid);
  if (existing && ["processed", "ignored"].includes(existing.processingStatus)) {
    return cardToast("该申请已处理");
  }
  if (!card.requestId || !card.action || !card.operatorOpenId || !card.nonce) {
    await record({
      eventUuid: card.eventUuid,
      eventType: card.eventType,
      cardRequestId: card.requestId,
      cardAction: card.action,
      operatorOpenId: card.operatorOpenId,
      messageId: card.messageId,
      processingStatus: "ignored",
      payloadJson: { encrypted, payload },
      errorMessage: "Missing package card requestId, action, operator open_id or nonce",
    });
    return cardToast("审批卡片参数不完整", "error");
  }

  try {
    const packageRequest = await findPackageRequestById(card.requestId);
    if (!packageRequest) {
      await record({
        eventUuid: card.eventUuid, eventType: card.eventType, cardRequestId: card.requestId,
        cardAction: card.action, operatorOpenId: card.operatorOpenId, messageId: card.messageId,
        processingStatus: "ignored", payloadJson: { encrypted, payload }, errorMessage: "Package request not found",
      });
      return cardToast("套餐申请不存在或已失效", "error");
    }
    if (!packageRequest.approvalActionNonceHash || sha256Hex(card.nonce) !== packageRequest.approvalActionNonceHash) {
      await record({
        eventUuid: card.eventUuid, eventType: card.eventType, cardRequestId: card.requestId,
        cardAction: card.action, operatorOpenId: card.operatorOpenId, messageId: card.messageId,
        processingStatus: "failed", payloadJson: { encrypted, payload }, errorMessage: "Invalid package card action nonce",
      });
      return cardToast("审批卡片校验失败", "error");
    }
    if (card.operatorOpenId !== packageRequest.approvalTargetOpenId) {
      await record({
        eventUuid: card.eventUuid, eventType: card.eventType, cardRequestId: card.requestId,
        cardAction: card.action, operatorOpenId: card.operatorOpenId, messageId: card.messageId,
        processingStatus: "ignored", payloadJson: { encrypted, payload }, errorMessage: "Package card operator is not the approval target",
      });
      return cardToast("当前用户无权审批此申请", "error");
    }
    const decision = normalizedDecision(card.action);
    if (!decision) return cardToast("不支持的审批动作", "error");
    const operator = await getUserByOpenId(card.operatorOpenId);
    const scope = operator ? await getEffectiveAdminScopeForUser(operator) : null;
    if (!operator || !scope) return cardToast("当前审批人没有启用的 TokenInside 管理范围", "error");
    const decided = await decidePackageRequest({
      scope,
      operatedByUserId: operator.id,
      operatedByOpenId: card.operatorOpenId,
      requestId: packageRequest.id,
      action: decision,
    });
    if (decision === "approve" && decided.operation) {
      after(async () => {
        try { await provisionApprovedPackageRequest(packageRequest.id); }
        catch (error) {
          await record({
            eventUuid: `${card.eventUuid}:package-provision`, eventType: card.eventType,
            cardRequestId: packageRequest.id, cardAction: card.action,
            operatorOpenId: card.operatorOpenId, messageId: card.messageId,
            processingStatus: "failed", payloadJson: { sourceEventUuid: card.eventUuid, packageRequestId: packageRequest.id },
            errorMessage: error instanceof Error ? error.message : "Package provisioning failed",
          });
        }
      });
    }
    await record({
      eventUuid: card.eventUuid, eventType: card.eventType, cardRequestId: card.requestId,
      cardAction: card.action, operatorOpenId: card.operatorOpenId, messageId: card.messageId,
      processingStatus: "processed", payloadJson: { encrypted, payload },
    });
    return cardToast(decision === "approve" ? "套餐申请已通过" : "套餐申请已拒绝");
  } catch (error) {
    await record({
      eventUuid: card.eventUuid, eventType: card.eventType, cardRequestId: card.requestId,
      cardAction: card.action, operatorOpenId: card.operatorOpenId, messageId: card.messageId,
      processingStatus: "failed", payloadJson: { encrypted, payload },
      errorMessage: error instanceof Error ? error.message : "Package card processing failed",
    });
    return cardToast("审批处理失败，请到管理后台处理", "error");
  }
}
