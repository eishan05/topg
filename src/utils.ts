import { createInterface } from "node:readline";

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(d|w|m)$/);
  if (!match) {
    throw new Error(`Invalid duration "${input}". Use format: <number><d|w|m> (e.g., 7d, 2w, 1m)`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const MS_PER_DAY = 86400000;
  switch (unit) {
    case "d": return value * MS_PER_DAY;
    case "w": return value * 7 * MS_PER_DAY;
    case "m": return value * 30 * MS_PER_DAY;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function askUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
