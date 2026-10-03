import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

/** The frontend is a set of ES modules; jsdom evaluates a classic script, so the tests bundle the entry point into one. */
export function frontendBundle(publicDir = 'public'): string {
  const out = buildSync({ entryPoints: [join(publicDir, 'app.js')], bundle: true, format: 'iife', write: false, logLevel: 'silent' });
  return out.outputFiles[0].text;
}

/** Every script of the frontend (entry point and modules), for checks that look at the shipped source itself. */
export function frontendSources(publicDir = 'public'): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(join(publicDir, dir), { withFileTypes: true })) {
      const rel = join(dir, e.name);
      if (e.isDirectory()) {
        if (rel !== 'assets') walk(rel);
      } else if (e.name.endsWith('.js')) files[rel] = readFileSync(join(publicDir, rel), 'utf8');
    }
  };
  walk('.');
  return files;
}
