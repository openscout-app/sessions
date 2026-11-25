#!/usr/bin/env node
import { cli } from "../dist/thin-server.mjs";

await cli(process.argv.slice(2));
