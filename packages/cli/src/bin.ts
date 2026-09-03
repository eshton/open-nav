#!/usr/bin/env node
import { run } from './main.js';

const exitCode = await run({
  argv: process.argv.slice(2),
  isTty: process.stdout.isTTY === true,
});
process.exitCode = exitCode;
