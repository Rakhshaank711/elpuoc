import { describe, expect, it } from "vitest";
import { stateChangedEventSchema } from "./realtime";

describe("realtime invalidation", () => {
  it("accepts only an actor id and rejects client-authored state", () => {
    const actorId = "00000000-0000-4000-8000-000000000001";
    expect(stateChangedEventSchema.safeParse({ actorId }).success).toBe(true);
    expect(stateChangedEventSchema.safeParse({ actorId, score: 8 }).success).toBe(false);
    expect(stateChangedEventSchema.safeParse({ actorId, secretWord: "Guitar" }).success).toBe(false);
  });
});
