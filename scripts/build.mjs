import { chmod, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildSkillCli(outfile = resolve(root, 'skills/cookiy-earn/scripts/cookiy-earn.js')) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, 'src/cli.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
  });
  if (process.platform !== 'win32') await chmod(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built ${await buildSkillCli()}`);
}
