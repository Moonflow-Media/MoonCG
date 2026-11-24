#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { run } from './cli.js';

/**
 * Asks for a secret. In a terminal what is typed is not shown; from a pipe the first line is
 * taken, so a script can feed it.
 */
function prompt(question: string): Promise<string> {
  const { stdin, stderr } = process;
  const lines = createInterface({ input: stdin, terminal: false });
  const answer = new Promise<string>((resolve) => {
    lines.once('line', resolve);
    lines.once('close', () => resolve(''));
  }).finally(() => lines.close());
  if (!stdin.isTTY) return answer;
  stderr.write(question);
  // Raw mode turns the terminal's own echo off; the line still ends with Enter.
  stdin.setRawMode(true);
  let typed = '';
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          lines.close();
          stderr.write('\n');
          resolve(typed);
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
        else typed += char;
      }
    };
    stdin.on('data', onData);
  });
}

process.exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  prompt,
});
// Asking for a password leaves stdin open; nothing else is left to do.
process.stdin.pause();
