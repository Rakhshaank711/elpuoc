import { describe, expect, it } from "vitest";
import { canUseClue, countClueWords, formatClock, isCorrectGuess, isRoundComplete, normalizeWord, scoreStatuses } from "./rules";

describe("game rules", () => {
  it("counts natural-language clue words", () => {
    expect(countClueWords("six strings")).toBe(2);
    expect(countClueWords("well-known, 6-string")).toBe(2);
    expect(countClueWords("   ")).toBe(0);
  });

  it("enforces the shared fifteen word budget", () => {
    expect(canUseClue("bright yellow flower", 12)).toBe(true);
    expect(canUseClue("bright yellow flower", 13)).toBe(false);
    expect(canUseClue("", 0)).toBe(false);
  });

  it("compares guesses without case, spaces, or punctuation", () => {
    expect(isCorrectGuess(" Sun-flower! ", "Sunflower")).toBe(true);
    expect(isCorrectGuess("sun", "Sunflower")).toBe(false);
    expect(normalizeWord("Rock & Roll")).toBe("rockroll");
  });

  it("derives scores and completion instead of trusting clients", () => {
    expect(scoreStatuses(["guessed", "skipped", "guessed"])).toBe(2);
    expect(isRoundComplete(8, null)).toBe(true);
    expect(isRoundComplete(1, new Date(Date.now() - 1).toISOString())).toBe(true);
  });

  it("formats the authoritative timer for display", () => {
    expect(formatClock(89.1)).toBe("01:30");
    expect(formatClock(-2)).toBe("00:00");
  });
});
