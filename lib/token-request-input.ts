import { z } from "zod";

export const tokenRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
