import * as fs from "node:fs";
import * as path from "node:path";

import { DEBUG, logFile } from "./config.js";

// pi runs a TUI, so logging to stdout/stderr would corrupt the display. We write
// to a file instead (like the CC plugin), with simple size-based rotation.
const MAX_BYTES = 5_000_000;
const BACKUP_COUNT = 3;

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) {
      return;
    }
    for (let i = BACKUP_COUNT; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      const dst = `${file}.${i}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
  } catch {
    // No file yet or rotation failed — nothing to do.
  }
}

function write(level: string, msg: string): void {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${formatTimestamp(new Date())} [${level}] ${msg}\n`, "utf-8");
  } catch {
    // Fail-open: logging must never throw.
  }
}

export function debug(msg: string): void {
  if (DEBUG) {
    write("DEBUG", msg);
  }
}

export function info(msg: string): void {
  write("INFO", msg);
}
