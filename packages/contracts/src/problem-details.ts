import { z } from './zod.js';

/** Stable, machine-readable problem codes produced by the API. */
export const PROBLEM_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'HTTP_ERROR',
  'INTERNAL_ERROR',
] as const;

export const ProblemCodeSchema = z.enum(PROBLEM_CODES).openapi('ProblemCode');

export const ValidationIssueSchema = z
  .object({
    path: z.string(),
    message: z.string(),
  })
  .strict()
  .openapi('ValidationIssue');

/** RFC 9457 problem details (media type application/problem+json). */
export const ProblemDetailsSchema = z
  .object({
    type: z.literal('about:blank'),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    detail: z.string(),
    instance: z.string(),
    code: ProblemCodeSchema,
    errors: z.array(ValidationIssueSchema).optional(),
  })
  .strict()
  .openapi('ProblemDetails');

export const PROBLEM_JSON_MEDIA_TYPE = 'application/problem+json';

export type ProblemCode = z.infer<typeof ProblemCodeSchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
