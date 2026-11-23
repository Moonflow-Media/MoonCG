// Run by storage-process.test.ts in a fresh Node process, where `node:sqlite` has not been
// loaded yet. Opens two databases at the same time and prints what warnings got through.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Lets Node run the TypeScript sources directly: an import of "./x.js" finds "./x.ts".
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const warnings = [];
process.on('warning', (warning) => warnings.push(warning.message));
const emitWarning = process.emitWarning;

const { openSqliteDb } = await import('../../src/storage/db.ts');
const databases = await Promise.all([openSqliteDb(':memory:'), openSqliteDb(':memory:')]);
for (const database of databases) database.close();

const restored = process.emitWarning === emitWarning;
process.emitWarning('still delivered');
await new Promise((resolve) => setImmediate(resolve));
console.log(JSON.stringify({ warnings, restored }));
