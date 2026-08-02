import { describe, expect, it } from "vitest";
import { gameActionSchema } from "./validation";

describe("game action validation", () => {
  it("normalizes room codes", () => {
    const result = gameActionSchema.parse({ action: "join", name: "Jamie", code: "love42", avatar: 1 });
    expect(result.action).toBe("join");
    if (result.action === "join") expect(result.code).toBe("LOVE42");
  });

  it("rejects client-authored score fields and invalid codes", () => {
    expect(() => gameActionSchema.parse({ action: "join", name: "Jamie", code: "bad" })).toThrow();
    const result = gameActionSchema.parse({ action: "skip", code: "ABC123", score: 8 });
    expect("score" in result).toBe(false);
  });
});
