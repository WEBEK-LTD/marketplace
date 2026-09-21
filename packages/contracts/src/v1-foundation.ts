import { z } from './zod.js';

/**
 * The `/v1` foundation probe.
 *
 * It exists to prove that the `/v1` boundary works — that the internal BFF credential is required, that
 * `/health` and `/ready` are not behind it, and that the problem-details shape is correct. It carries no
 * business meaning and no user context, and it is deliberately **not** an authentication endpoint: the
 * response says nothing about who is calling, because at this layer nobody has proven who they are.
 */
export const V1FoundationResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .strict()
  .openapi('V1FoundationResponse');

export type V1FoundationResponse = z.infer<typeof V1FoundationResponseSchema>;
