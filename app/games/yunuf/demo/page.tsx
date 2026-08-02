import type { Metadata } from "next";
import { YunufDemo } from "@/components/yunuf-demo";

export const metadata: Metadata = { title: "Yunuf Rules Lab", robots: { index: false, follow: false } };
export default function YunufDemoPage() { return <YunufDemo/>; }
