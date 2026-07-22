import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TokenInside",
  description: "飞书用户的 NewAPI Key 与套餐管理控制台",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
