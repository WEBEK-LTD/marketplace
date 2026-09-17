// Generates the typed fetch client from the committed OpenAPI document.
// ORVAL_OUTPUT is used only by scripts/check-generated.mjs to write to a temporary file.
export default {
  api: {
    input: { target: './openapi/openapi.json' },
    output: {
      target: process.env.ORVAL_OUTPUT ?? './src/generated/api-client.ts',
      mode: 'single',
      client: 'fetch',
      prettier: false,
      clean: false,
      override: {
        mutator: { path: './src/client/api-fetch.ts', name: 'apiFetch' },
      },
    },
  },
};
