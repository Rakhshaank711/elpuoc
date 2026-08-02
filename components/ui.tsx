"use client";

import { Heart, Moon, Sparkles, Sun, type LucideIcon } from "lucide-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

export function Button({ children, kind = "primary", className = "", ...props }: ComponentPropsWithRef<"button"> & { kind?: "primary" | "secondary" | "ghost" }) {
  const styles = kind === "primary"
    ? "bg-[var(--coral)] text-[#241115] border-transparent shadow-[0_8px_28px_rgba(255,98,104,.18)]"
    : kind === "secondary"
      ? "bg-transparent text-[var(--ink)] border-[var(--coral)]/55"
      : "bg-white/[.045] text-[var(--muted)] border-white/[.08]";
  return <button className={`min-h-12 w-full rounded-xl border px-5 text-[13px] font-extrabold transition active:scale-[.985] disabled:cursor-not-allowed disabled:opacity-45 ${styles} ${className}`} {...props}>{children}</button>;
}

const avatarIcons: LucideIcon[] = [Moon, Heart, Sun, Sparkles];
const avatarColors = ["#ff817d", "#eaa0bd", "#dbc34f", "#b89be6"];

export function Avatar({ index = 0, size = "md", active = false }: { index?: number; size?: "sm" | "md" | "lg"; active?: boolean }) {
  const Icon = avatarIcons[index % avatarIcons.length];
  const px = size === "lg" ? 66 : size === "md" ? 44 : 28;
  return <div className="relative shrink-0">
    {active && <span className="absolute inset-[-5px] rounded-full border border-[var(--coral)]/55" />}
    <div className="grid place-items-center rounded-full border border-white/10 bg-[#181313]" style={{ width: px, height: px }}>
      <Icon size={px * .38} fill={`${avatarColors[index % avatarColors.length]}20`} color={avatarColors[index % avatarColors.length]} strokeWidth={1.7} />
    </div>
    {active && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-[#100e0d] bg-emerald-400" />}
  </div>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`flex items-center gap-2 font-black text-[var(--peach)] ${compact ? "text-[13px]" : "text-lg"}`}>
    <span className="grid size-6 place-items-center rounded-lg border border-[var(--coral)]/30 bg-[var(--coral)]/10 text-[10px]">15</span>
    <span>15 Words</span>
  </div>;
}

export function Screen({ children, plum = false, className = "" }: { children: ReactNode; plum?: boolean; className?: string }) {
  return <main style={{ backgroundColor: plum ? "var(--plum)" : "var(--night)" }} className={`phone-shell safe-bottom animate-pop ${className}`}>{children}</main>;
}

export function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return <label className="block">
    {label && <span className="mb-2 block text-xs font-bold text-[var(--peach)]">{label}</span>}
    <input className="h-13 w-full rounded-xl border border-white/10 bg-black/25 px-4 text-[15px] font-semibold text-white outline-none placeholder:text-white/25 focus:border-[var(--coral)]/60" {...props} />
  </label>;
}
