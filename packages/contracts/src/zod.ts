import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Adds `.openapi(...)` metadata support; must run before any schema is defined.
extendZodWithOpenApi(z);

export { z };
