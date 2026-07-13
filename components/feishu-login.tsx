"use client";

import { useEffect, useState } from "react";
import Script from "next/script";

const feishuH5SdkSrc = "https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.30.js";

type FeishuSdkError = {
  errno?: number;
  errCode?: number;
  errString?: string;
  errMsg?: string;
  message?: string;
};

type FeishuAuthCodeResponse = {
  code?: string;
  state?: string;
};

type FeishuAuthMethod = "requestAccess" | "requestAuthCode";

type FeishuLoginResult = {
  method: FeishuAuthMethod;
  redirectTo: "/" | "/admin";
};

declare global {
  interface Window {
    h5sdk?: {
      ready?: (callback: () => void) => void;
      error?: (callback: (error: unknown) => void) => void;
    };
    tt?: {
      requestAccess?: (options: {
        appID: string;
        scopeList: string[];
        success?: (res: FeishuAuthCodeResponse) => void;
        fail?: (err: unknown) => void;
      }) => void;
      requestAuthCode?: (options: {
        appId: string;
        success?: (res: FeishuAuthCodeResponse) => void;
        fail?: (err: unknown) => void;
      }) => void;
    };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLikelyFeishuClient() {
  if (typeof navigator === "undefined") return false;
  return /Feishu|FeiShu|FeishuLocale|FeishuVersion|Lark|LarkLocale|LarkVersion/i.test(
    navigator.userAgent,
  );
}

function hasFeishuRuntimeGlobal() {
  return typeof window !== "undefined" && Boolean(window.h5sdk || window.tt);
}

function canAttemptFeishuH5Login() {
  return isLikelyFeishuClient() || hasFeishuRuntimeGlobal();
}

function isSdkError(value: unknown): value is FeishuSdkError {
  return typeof value === "object" && value !== null;
}

function sdkErrno(value: unknown) {
  if (!isSdkError(value)) return undefined;
  if (typeof value.errno === "number") return value.errno;
  if (typeof value.errCode === "number") return value.errCode;
  return undefined;
}

function currentRedirectUrl() {
  if (typeof window === "undefined") return "";
  return window.location.href.split("?")[0].split("#")[0];
}

function formatSdkError(value: unknown) {
  if (!isSdkError(value)) {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "未知错误");
  }

  return (
    value.errString ??
    value.errMsg ??
    value.message ??
    JSON.stringify(value)
  );
}

function isInvalidRedirectUriError(value: unknown) {
  const code = sdkErrno(value);
  if (code === 20029) return true;

  const message = formatSdkError(value).toLowerCase();
  return message.includes("invalid redirect uri") || message.includes("redirect_uri unmatch");
}

function invalidRedirectUriMessage(err: unknown) {
  const redirectUrl = currentRedirectUrl();
  const hint = redirectUrl
    ? `请在飞书开放平台对应应用的「安全设置」>「重定向 URL」中添加当前页面地址：${redirectUrl}。`
    : "请在飞书开放平台对应应用的「安全设置」>「重定向 URL」中添加当前调用 requestAccess 的页面地址。";

  return [
    "飞书 requestAccess 失败：当前页面没有通过飞书 H5 重定向 URL 安全校验。",
    hint,
    "首页和 /admin 都会自动免登，两个页面都需要分别加入重定向 URL；URL 查询参数和 # 片段不需要配置。",
    `飞书原始错误：${formatSdkError(err)}`,
  ].join(" ");
}

async function waitForFeishuGlobals(timeoutMs: number) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (window.h5sdk?.ready && window.tt) return;
    await sleep(100);
  }

  throw new Error(
    "未检测到飞书 H5 JSSDK。请确认页面从飞书工作台网页应用入口打开，且 H5 JSSDK 已加载。",
  );
}

export async function waitForFeishuSdkReady(timeoutMs = 8000) {
  await waitForFeishuGlobals(timeoutMs);

  return new Promise<void>((resolve, reject) => {
    const h5sdk = window.h5sdk;
    if (!h5sdk?.ready) {
      reject(new Error("飞书 H5 JSSDK 未提供 ready 回调。"));
      return;
    }

    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("飞书 H5 JSSDK 初始化超时。"));
    }, timeoutMs);

    h5sdk.error?.((error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(new Error(`飞书 H5 JSSDK 初始化失败：${formatSdkError(error)}`));
    });

    h5sdk.ready(() => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (!window.tt) {
        reject(new Error("飞书 H5 JSSDK ready 后仍未检测到 tt 对象。"));
        return;
      }
      resolve();
    });
  });
}

async function getFeishuAppId() {
  const res = await fetch("/api/feishu/app-id", { cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as {
    appId?: string;
    error?: string;
  };

  if (!res.ok || !body.appId) {
    throw new Error(body.error ?? "飞书应用 App ID 未配置。");
  }

  return body.appId;
}

function requireCode(res: FeishuAuthCodeResponse, method: FeishuAuthMethod) {
  if (!res.code) {
    throw new Error(`${method} 未返回授权码。`);
  }
  return res.code;
}

function requestAuthCode(appId: string) {
  return new Promise<{ code: string; method: FeishuAuthMethod }>((resolve, reject) => {
    const requestAuthCodeApi = window.tt?.requestAuthCode;
    if (!requestAuthCodeApi) {
      reject(new Error("当前飞书客户端不支持 requestAuthCode。"));
      return;
    }

    requestAuthCodeApi({
      appId,
      success: (res) => {
        try {
          resolve({ code: requireCode(res, "requestAuthCode"), method: "requestAuthCode" });
        } catch (err) {
          reject(err);
        }
      },
      fail: (err) => {
        reject(new Error(`飞书 requestAuthCode 失败：${formatSdkError(err)}`));
      },
    });
  });
}

function requestAccess(appId: string) {
  return new Promise<{ code: string; method: FeishuAuthMethod }>((resolve, reject) => {
    const requestAccessApi = window.tt?.requestAccess;
    if (!requestAccessApi) {
      void requestAuthCode(appId).then(resolve, reject);
      return;
    }

    requestAccessApi({
      appID: appId,
      scopeList: [],
      success: (res) => {
        try {
          resolve({ code: requireCode(res, "requestAccess"), method: "requestAccess" });
        } catch (err) {
          reject(err);
        }
      },
      fail: (err) => {
        if (sdkErrno(err) === 103 && window.tt?.requestAuthCode) {
          void requestAuthCode(appId).then(resolve, reject);
          return;
        }
        if (isInvalidRedirectUriError(err)) {
          reject(new Error(invalidRedirectUriMessage(err)));
          return;
        }
        reject(new Error(`飞书 requestAccess 失败：${formatSdkError(err)}`));
      },
    });
  });
}

async function submitFeishuCode(code: string) {
  const callback = await fetch("/api/auth/feishu/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

  const body = (await callback.json().catch(() => ({}))) as {
    error?: string;
    redirectTo?: string;
  };
  if (!callback.ok) {
    throw new Error(body.error ?? "飞书登录失败。");
  }
  return body.redirectTo === "/admin" ? "/admin" : "/";
}

export async function loginWithFeishu(): Promise<FeishuLoginResult> {
  if (!canAttemptFeishuH5Login()) {
    throw new Error("当前浏览器没有检测到飞书 H5 JSAPI，请从飞书工作台应用入口打开。");
  }

  const appId = await getFeishuAppId();
  await waitForFeishuSdkReady();
  const authCode = await requestAccess(appId);
  const redirectTo = await submitFeishuCode(authCode.code);
  return { method: authCode.method, redirectTo };
}

export function FeishuSdkScript({
  onReady,
  onError,
}: {
  onReady?: () => void;
  onError?: (message: string) => void;
}) {
  const [shouldLoadSdk, setShouldLoadSdk] = useState(false);

  useEffect(() => {
    setShouldLoadSdk(canAttemptFeishuH5Login());
  }, []);

  if (!shouldLoadSdk) return null;

  return (
    <Script
      id="feishu-h5-sdk"
      src={feishuH5SdkSrc}
      strategy="afterInteractive"
      onReady={() => {
        void waitForFeishuSdkReady(2500)
          .then(() => onReady?.())
          .catch((err) => {
            onError?.(err instanceof Error ? err.message : "飞书 H5 JSSDK 初始化失败。");
          });
      }}
      onError={() => {
        onError?.("飞书 H5 JSSDK 加载失败，请检查网络或飞书客户端环境。");
      }}
    />
  );
}
