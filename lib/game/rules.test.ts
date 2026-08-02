import { describe, expect, it } from "vitest";
import { canUseClue, countClueWords, isCorrectGuess, isRoundComplete, normalizeWord, scoreStatuses } from "./rules";

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
    expect(isRoundComplete(8)).toBe(true);
    expect(isRoundComplete(1)).toBe(false);
  });
});
