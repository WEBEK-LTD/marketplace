// Writes dist/tokens.css from the compiled design tokens.
import { writeFileSync } from 'node:fs';
import { tokensToCss } from '../dist/tokens-css.js';

writeFileSync(new URL('../dist/tokens.css', import.meta.url), tokensToCss());
