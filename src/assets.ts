import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXT = /\.(png|jpe?g|webp|avif|svg|gif)$/i;

/**
 * Scan `<publicDir>/assets` and return { "items/itm_Blade_1": { file: "items/itm_Blade_1.png", v: mtimeMs } }.
 * Keys have no extension, so artists can supply png, jpg, webp or svg per image without touching code.
 */
export function listAssets(publicDir: string): Record<string, { file: string; v: number }> {
  const root = join(publicDir, 'assets');
  const out: Record<string, { file: string; v: number }> = {};
  if (!existsSync(root)) return out;
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const file = rel.split('\\').join('/');
    if (!EXT.test(file)) continue;
    out[file.replace(EXT, '')] = { file, v: Math.floor(statSync(join(root, rel)).mtimeMs) };
  }
  return out;
}
