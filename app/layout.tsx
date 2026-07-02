import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TokenInside",
  description: "Feishu-bound NewAPI token control plane and proxy gateway",
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
