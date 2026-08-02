import type { Metadata } from "next";
import { GameApp } from "@/components/game-app";

export const metadata: Metadata = {
  title: "15 Words — How well do you know each other?",
  description: "A private two-player clue game for couples.",
};

export default function FifteenWordsPage() {
  return <GameApp />;
}
