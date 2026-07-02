import * as React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "outline" | "ghost" | "secondary";
type ButtonSize = "default" | "sm";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "button",
        variant === "outline" && "button-outline",
        variant === "ghost" && "button-ghost",
        variant === "secondary" && "button-secondary",
        size === "sm" && "button-sm",
        className,
      )}
      {...props}
    />
  );
}
