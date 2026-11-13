// shadcn-style source-owned button: Radix Slot + class-variance-authority.
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { ComponentProps } from "react";

const variants = cva("button", { variants: { variant: { default: "button-default", primary: "button-primary", ghost: "button-ghost" }, size: { default: "", icon: "button-icon" } }, defaultVariants: { variant: "default", size: "default" } });
export function Button({ className, variant, size, asChild, ...props }: ComponentProps<"button"> & VariantProps<typeof variants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={twMerge(clsx(variants({ variant, size }), className))} {...props} />;
}
