#!/usr/bin/env node

import { runWordAgenttoolCli } from "../src/cli.js";

process.exitCode = await runWordAgenttoolCli(process.argv.slice(2));
