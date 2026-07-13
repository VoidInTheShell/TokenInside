"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

const INITIAL_PROGRESS = 18;

export function LoginWaitingScreen() {
  const [progress, setProgress] = useState(INITIAL_PROGRESS);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reducedMotion.matches) {
      setProgress(58);
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
  }, []);

  return (
    <main className="login-waiting-screen" aria-busy="true" aria-live="polite">
      <div className="login-waiting-brand">
        <Image src="/icon.svg" alt="" aria-hidden="true" width={42} height={42} priority />
        <div>
          <strong>TokenInside</strong>
          <span>共绩科技</span>
        </div>
      </div>

      <Card className="login-waiting-card">
        <CardHeader>
          <CardTitle>正在通过飞书登录</CardTitle>
          <CardDescription>正在确认当前飞书身份，请保持页面打开。</CardDescription>
        </CardHeader>
        <CardContent>
          <Progress
            value={progress}
            aria-label="飞书登录进度"
            aria-valuetext="正在通过飞书登录"
          />
          <div className="login-waiting-meta">
            <span>身份验证</span>
            <span>正在安全连接</span>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
