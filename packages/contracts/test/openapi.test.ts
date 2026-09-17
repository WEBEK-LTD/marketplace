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

  it('contains only the Step 3 operations', () => {
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(['/health', '/ready']);
    expect(doc.paths?.['/health']?.get?.operationId).toBe('getHealth');
    expect(doc.paths?.['/ready']?.get?.operationId).toBe('getReadiness');
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
