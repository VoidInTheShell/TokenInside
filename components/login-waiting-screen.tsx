"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const INITIAL_PROGRESS = 18;
const ADMIN_PROVISIONING_PROGRESS = 58;

export function LoginWaitingScreen({
  mode = "authentication",
  error,
  onRetry,
  retrying = false,
}: {
  mode?: "authentication" | "admin-provisioning";
  error?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const isAdminProvisioning = mode === "admin-provisioning";
  const [progress, setProgress] = useState(
    isAdminProvisioning ? ADMIN_PROVISIONING_PROGRESS : INITIAL_PROGRESS,
  );

  useEffect(() => {
    setProgress(isAdminProvisioning ? ADMIN_PROVISIONING_PROGRESS : INITIAL_PROGRESS);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) {
      setProgress(isAdminProvisioning ? 82 : 58);
      return;
    }

    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 92) return current;
        if (current < 50) return Math.min(92, current + 7);
        if (current < 76) return Math.min(92, current + 4);
        return Math.min(92, current + 1);
      });
    }, 520);

    return () => window.clearInterval(timer);
  }, [isAdminProvisioning]);

  const title = isAdminProvisioning ? "正在准备用户后台" : "正在通过飞书登录";
  const description = isAdminProvisioning
    ? "飞书身份已确认，正在首次发放专属 Key，请保持页面打开。"
    : "正在确认当前飞书身份，请保持页面打开。";
  const progressText = isAdminProvisioning ? "正在首次发放管理员 Key" : "正在通过飞书登录";

  return (
    <main className="login-waiting-screen" aria-busy={!error} aria-live="polite">
      <div className="login-waiting-brand">
        <Image src="/icon.svg" alt="" aria-hidden="true" width={42} height={42} priority />
        <div>
          <strong>TokenInside</strong>
          <span>共绩科技</span>
        </div>
      </div>

      <Card className="login-waiting-card">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription role={error ? "alert" : undefined}>
            {error ?? description}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress
            value={progress}
            aria-label={isAdminProvisioning ? "管理员 Key 首次发放进度" : "飞书登录进度"}
            aria-valuetext={progressText}
          />
          <div className="login-waiting-meta">
            <span>{isAdminProvisioning ? "管理员身份已确认" : "身份验证"}</span>
            <span>{error ? "发放尚未完成" : progressText}</span>
          </div>
        </CardContent>
        {error && onRetry ? (
          <CardFooter>
            <Button variant="outline" onClick={onRetry} disabled={retrying}>
              <RefreshCwIcon data-icon="inline-start" />
              {retrying ? "正在重试" : "重试发放"}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
