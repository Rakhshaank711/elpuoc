import { z } from "zod";

// Broadcast never carries game state. It only prompts an authenticated read.
export const stateChangedEventSchema = z.object({ actorId: z.string().uuid() }).strict();
