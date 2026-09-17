// Writes the OpenAPI document generated from the compiled contracts.
import { writeFileSync } from 'node:fs';
import { serializeOpenApiDocument } from '../dist/openapi/document.js';

writeFileSync(new URL('../openapi/openapi.json', import.meta.url), serializeOpenApiDocument());
