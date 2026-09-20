// Vitest global setup for backend tests. Selects a local MongoDB binary for
// mongodb-memory-server when one is installed, avoiding a large binary download.
import fs from "node:fs";

const SYSTEM_MONGOD_CANDIDATES = [
  "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe",
  "C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe",
];

for (const candidate of SYSTEM_MONGOD_CANDIDATES) {
  if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync(candidate)) {
    process.env.MONGOMS_SYSTEM_BINARY = candidate;
    break;
  }
}
