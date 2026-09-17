import { HttpException } from '@nestjs/common';
import type { ProblemCode, ProblemDetails, ValidationIssue } from '@repo/contracts';
import { RequestValidationException } from './request-validation.exception.js';

interface ProblemSpec {
  readonly status: number;
  readonly code: ProblemCode;
  readonly errors?: readonly ValidationIssue[];
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const DETAILS: Readonly<Record<ProblemCode, string>> = {
  BAD_REQUEST: 'The request could not be processed.',
  VALIDATION_FAILED: 'The request is invalid.',
  NOT_FOUND: 'The requested resource was not found.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'The request content type is not supported.',
  HTTP_ERROR: 'The request could not be completed.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}

function statusOf(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : undefined;
}

/** Maps any thrown value to a safe problem specification. Never uses the error message. */
export function classifyError(error: unknown): ProblemSpec {
  if (error instanceof RequestValidationException) {
    return { status: 400, code: 'VALIDATION_FAILED', errors: error.issues };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: codeForStatus(status) };
  }
  const status = statusOf(error);
  if (status !== undefined && status < 500) {
    return { status, code: codeForStatus(status) };
  }
  return { status: 500, code: 'INTERNAL_ERROR' };
}

export function buildProblem(spec: ProblemSpec, instance: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[spec.status] ?? (spec.status >= 500 ? 'Server Error' : 'Client Error'),
    status: spec.status,
    detail: DETAILS[spec.code],
    instance,
    code: spec.code,
  };
  return spec.errors === undefined ? problem : { ...problem, errors: [...spec.errors] };
}

/** The request path without its query string. */
export function instanceFromUrl(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0] ?? '/';
  return path.length > 0 ? path : '/';
}
