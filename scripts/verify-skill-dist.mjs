import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSkillCli } from './build.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'cookiy-earn-dist-'));
try {
  const generated = join(temporary, 'cookiy-earn.js');
  await buildSkillCli(generated);
  const [expectedBytes, generatedBytes] = await Promise.all([
    readFile(resolve('skills/cookiy-earn/scripts/cookiy-earn.js')),
    readFile(generated),
  ]);
  if (!expectedBytes.equals(generatedBytes)) {
    console.error('skills/cookiy-earn/scripts/cookiy-earn.js is stale. Run `pnpm build` and commit the result.');
    process.exitCode = 1;
  } else {
    console.log('Skill distribution is synchronized with TypeScript sources.');
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
