import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, serializeOpenApiDocument } from '../src/index.js';

const committed = readFileSync(new URL('../openapi/openapi.json', import.meta.url), 'utf8');

describe('OpenAPI document', () => {
  const doc = generateOpenApiDocument();

  it('uses the approved header', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'API', version: '0.0.0' });
  });

  it('contains only the documented operations', () => {
    // The health and readiness checks from Phase 1 Step 3, plus the single `/v1` foundation probe added
    // with the internal BFF credential boundary. Anything else appearing here is an undocumented route
    // or a business endpoint that has not been approved.
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(['/health', '/ready', '/v1/foundation']);
    expect(doc.paths?.['/health']?.get?.operationId).toBe('getHealth');
    expect(doc.paths?.['/ready']?.get?.operationId).toBe('getReadiness');
    expect(doc.paths?.['/v1/foundation']?.get?.operationId).toBe('getV1Foundation');
  });

  it('documents the /v1 foundation probe as guarded and business-free', () => {
    const responses = doc.paths?.['/v1/foundation']?.get?.responses ?? {};
    // 403 for a refused internal credential; no 401, because this boundary is not user authentication.
    expect(Object.keys(responses).sort()).toEqual(['200', '403', '500']);
    const forbidden = responses['403'] as { content?: Record<string, unknown> };
    expect(Object.keys(forbidden.content ?? {})).toEqual(['application/problem+json']);
  });

  it('uses application/problem+json for error responses', () => {
    const error = doc.paths?.['/health']?.get?.responses?.['500'] as { content?: Record<string, unknown> };
    expect(Object.keys(error.content ?? {})).toEqual(['application/problem+json']);
  });

  it('is deterministic and matches the committed file', () => {
    expect(serializeOpenApiDocument()).toBe(serializeOpenApiDocument());
    expect(serializeOpenApiDocument()).toBe(committed);
  });
});
