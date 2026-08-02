import { CLUE_WORD_LIMIT, WORDS_PER_ROUND } from "./constants";

export function normalizeWord(value: string) {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

export function countClueWords(value: string) {
  const matches = value.trim().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches?.length ?? 0;
}

export function isCorrectGuess(guess: string, answer: string) {
  return normalizeWord(guess) === normalizeWord(answer);
}

export function canUseClue(clue: string, used: number) {
  const count = countClueWords(clue);
  return count > 0 && used + count <= CLUE_WORD_LIMIT;
}

export function scoreStatuses(statuses: string[]) {
  return statuses.filter((status) => status === "guessed").length;
}

export function isRoundComplete(index: number, endsAt: string | null, now = Date.now()) {
  return index >= WORDS_PER_ROUND || (endsAt !== null && new Date(endsAt).getTime() <= now);
}

export function formatClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
