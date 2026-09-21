import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { HealthResponseSchema, ReadinessResponseSchema } from '../health.js';
import { PROBLEM_JSON_MEDIA_TYPE, ProblemDetailsSchema } from '../problem-details.js';
import { V1FoundationResponseSchema } from '../v1-foundation.js';

const internalError = {
  description: 'Unexpected server error',
  content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
} as const;

function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  registry.registerPath({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness check',
    responses: {
      200: {
        description: 'The API process is running',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/ready',
    operationId: 'getReadiness',
    summary: 'Readiness check',
    responses: {
      200: {
        description: 'All dependency checks passed',
        content: { 'application/json': { schema: ReadinessResponseSchema } },
      },
      503: {
        description: 'At least one dependency check failed',
        content: { 'application/json': { schema: ReadinessResponseSchema } },
      },
      500: internalError,
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/foundation',
    operationId: 'getV1Foundation',
    summary: 'Foundation probe for the /v1 boundary',
    description:
      'Requires the internal BFF credential. Carries no user context and authorizes nothing.',
    responses: {
      200: {
        description: 'The /v1 boundary is reachable by an approved internal caller',
        content: { 'application/json': { schema: V1FoundationResponseSchema } },
      },
      403: {
        description: 'The internal BFF credential is missing, wrong or malformed',
        content: { [PROBLEM_JSON_MEDIA_TYPE]: { schema: ProblemDetailsSchema } },
      },
      500: internalError,
    },
  });

  return registry;
}

/** Builds the OpenAPI 3.1 document from the Zod contracts. */
export function generateOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'API', version: '0.0.0' },
  });
}

/** Deterministic serialisation used for the committed document. */
export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
}
