import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { RequestValidationException } from './request-validation.exception.js';

/** Validates a request value (body, query, params) against a Zod schema. */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<unknown, z.output<TSchema>> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new RequestValidationException(
        result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      );
    }
    return result.data;
  }
}
