import type { Metadata } from "next";
import { YunufApp } from "@/components/yunuf-app";

export const metadata: Metadata = {
  title: "Yunuf — Outsmart the table",
  description: "A private 2–5 player card game of clever discards, risky Shows, and survival.",
};

export default function YunufPage() { return <YunufApp/>; }
