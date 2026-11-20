#!/usr/bin/env node
/** VERIFIED: The CLI reports a short diagnostic while the compiler keeps the previous output intact. */
import { generateContracts } from './generate.mjs';

generateContracts(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
