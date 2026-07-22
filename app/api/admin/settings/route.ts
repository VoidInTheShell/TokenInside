import { NextResponse } from "next/server";
import { z } from "zod";
import { isRootAdminScope, requireAdminScope } from "@/lib/admin";
import { getConfig } from "@/lib/config";
import {
  invalidateEffectiveNewApiConfig,
  newApiAccessTokenSecretContext,
  verifyNewApiControlIdentity,
} from "@/lib/newapi-runtime";
import { isAdminUserActionAuthorizationError } from "@/lib/postgres-store";
import {
  nextPackageResetAt,
  normalizePackageResetPolicy,
} from "@/lib/package-reset";
import { notifyPackageResetScheduler } from "@/lib/package-reset-scheduler";
import { sealAppSecret } from "@/lib/secret-box";
import {
  getAppSettings,
  updateAppSettingsAsActor,
} from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsSchema = z
  .object({
    defaultMonthlyQuota: z.number().int().positive().max(1000000).optional(),
    newapiControl: z.object({
      baseUrl: z.string().url().max(500),
      controlUserId: z.string().trim().min(1).max(100),
      accessToken: z.string().trim().min(1).max(2000).optional(),
    }).optional(),
    packageReset: z
      .object({
        enabled: z.boolean(),
        dayOfMonth: z.number().int().min(1).max(31),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.defaultMonthlyQuota !== undefined ||
      value.newapiControl !== undefined ||
      value.packageReset !== undefined,
  );

function visibleSettings(
  settings: Awaited<ReturnType<typeof getAppSettings>>,
  root: boolean,
) {
  const { newapiControl } = settings;
  const fallback = getConfig().newapi;
  const packageReset = normalizePackageResetPolicy(settings.packageReset);
  const nextResetAt = nextPackageResetAt(packageReset);
  return {
    defaultMonthlyQuota: settings.defaultMonthlyQuota,
    packageReset: {
      ...packageReset,
      nextResetAt: nextResetAt?.toISOString(),
    },
    updatedAt: settings.updatedAt,
    ...(root
      ? {
          newapiControl: {
            baseUrl: newapiControl?.baseUrl ?? fallback.baseUrl,
            controlUserId: newapiControl?.controlUserId ?? fallback.controlUserId,
            accessTokenConfigured: Boolean(
              newapiControl?.accessTokenCiphertext ||
                fallback.accessToken ||
                fallback.adminAccessToken ||
                fallback.systemAk,
            ),
            source: newapiControl ? "system_settings" : "environment",
            updatedAt: newapiControl?.updatedAt,
          },
        }
      : {}),
  };
}

export async function GET() {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "系统设置只能由全局管理员访问" },
      { status: 403 },
    );
  }
  const settings = await getAppSettings();
  return NextResponse.json({ settings: visibleSettings(settings, isRootAdminScope(auth.scope)) });
}

export async function PATCH(request: Request) {
  const auth = await requireAdminScope();
  if (auth.error) return auth.error;
  if (auth.scope.scopeType !== "global") {
    return NextResponse.json(
      { error: "系统设置只能由全局管理员访问" },
      { status: 403 },
    );
  }
  const parsed = settingsSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "默认额度必须是正整数，套餐重置日必须在 1 到 31 日之间，NewAPI 上游连接必须完整有效" },
      { status: 400 },
    );
  }
  if (parsed.data.newapiControl && !isRootAdminScope(auth.scope)) {
    return NextResponse.json(
      { error: "NewAPI 上游连接只能由 root 管理员修改" },
      { status: 403 },
    );
  }
  if (parsed.data.newapiControl) {
    const current = await getAppSettings();
    const fallback = getConfig().newapi;
    const currentBaseUrl = current.newapiControl?.baseUrl ?? fallback.baseUrl;
    const currentControlUserId =
      current.newapiControl?.controlUserId ?? fallback.controlUserId;
    const identityChanged =
      currentBaseUrl.replace(/\/+$/, "") !==
        parsed.data.newapiControl.baseUrl.replace(/\/+$/, "") ||
      currentControlUserId !== parsed.data.newapiControl.controlUserId;
    if (identityChanged && !parsed.data.newapiControl.accessToken) {
      return NextResponse.json(
        { error: "修改 NewAPI 地址或控制用户时必须填写对应的用户 AK" },
        { status: 400 },
      );
    }
    if (parsed.data.newapiControl.accessToken) {
      try {
        await verifyNewApiControlIdentity({
          baseUrl: parsed.data.newapiControl.baseUrl,
          controlUserId: parsed.data.newapiControl.controlUserId,
          credential: parsed.data.newapiControl.accessToken,
          requestTimeoutMs: getConfig().newapi.requestTimeoutMs,
        });
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "NewAPI 用户 AK 身份验证失败",
            code: "newapi_identity_verification_failed",
          },
          { status: 409 },
        );
      }
    }
  }
  const newapiControl = parsed.data.newapiControl
    ? {
        baseUrl: parsed.data.newapiControl.baseUrl.replace(/\/+$/, ""),
        controlUserId: parsed.data.newapiControl.controlUserId,
        accessTokenCiphertext: parsed.data.newapiControl.accessToken
          ? sealAppSecret(
              parsed.data.newapiControl.accessToken,
              newApiAccessTokenSecretContext(),
            )
          : undefined,
        updatedAt: new Date().toISOString(),
        updatedByFeishuUserId: auth.user.id,
      }
    : undefined;
  let settings;
  try {
    settings = await updateAppSettingsAsActor({
      actorFeishuUserId: auth.user.id,
      defaultMonthlyQuota: parsed.data.defaultMonthlyQuota,
      newapiControl,
      packageReset: parsed.data.packageReset,
    });
  } catch (error) {
    if (isAdminUserActionAuthorizationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    if (error instanceof Error && error.name === "NewApiControlSecretRequiredError") {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  if (newapiControl) invalidateEffectiveNewApiConfig();
  if (parsed.data.packageReset) notifyPackageResetScheduler();
  return NextResponse.json({
    settings: visibleSettings(settings, isRootAdminScope(auth.scope)),
  });
}
