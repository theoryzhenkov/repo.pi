#!/usr/bin/env node
import { runStdioBridge } from "./stdio-server.js";

if (process.argv.includes("--stdio")) {
	runStdioBridge();
} else {
	console.error("Usage: pi-bridge --stdio");
	process.exit(1);
}
