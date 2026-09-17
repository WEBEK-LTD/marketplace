import type { ValidationIssue } from '@repo/contracts';

/** Raised by the validation pipe; turned into a VALIDATION_FAILED problem response. */
export class RequestValidationException extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Request validation failed.');
    this.name = 'RequestValidationException';
    this.issues = issues;
  }
}
