import { z } from './zod.js';

export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('HealthResponse');

export const ReadinessCheckResultSchema = z
  .object({
    name: z.string(),
    status: z.enum(['ok', 'failed']),
  })
  .strict()
  .openapi('ReadinessCheckResult');

export const ReadinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.array(ReadinessCheckResultSchema),
  })
  .strict()
  .openapi('ReadinessResponse');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadinessCheckResult = z.infer<typeof ReadinessCheckResultSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
