import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILLS_VERSION = '1.5.23';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'skills/cookiy-earn');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args, cwd) {
  const result = spawnSync(npx, ['--yes', `skills@${SKILLS_VERSION}`, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`skills ${args[0]} failed (${result.status ?? 'signal'}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

async function findSkillFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findSkillFiles(child));
    else if (entry.isFile() && entry.name === 'SKILL.md') found.push(child);
  }
  return found;
}

for (const agent of ['codex', 'claude-code']) {
  const workspace = await mkdtemp(join(tmpdir(), `cookiy-${agent}-install-`));
  try {
    run(['add', source, '--agent', agent, '--copy', '-y'], workspace);
    run(['add', source, '--agent', agent, '--copy', '-y'], workspace);
    const listing = run(['list', '--agent', agent, '--json'], workspace);
    if (!listing.includes('cookiy-earn')) throw new Error(`${agent} did not discover cookiy-earn after installation.`);

    const skillFiles = await findSkillFiles(workspace);
    let installedSkill;
    for (const file of skillFiles) {
      if ((await readFile(file, 'utf8')).includes('name: cookiy-earn')) {
        installedSkill = file;
        break;
      }
    }
    if (!installedSkill) throw new Error(`${agent} installation did not contain cookiy-earn/SKILL.md.`);
    const installedBundle = resolve(dirname(installedSkill), 'scripts/cookiy-earn.js');
    if (basename(installedBundle) !== 'cookiy-earn.js') throw new Error('Unexpected bundle path.');
    const help = spawnSync(process.execPath, [installedBundle, '--help'], { encoding: 'utf8' });
    if (help.status !== 0 || !help.stdout.includes('Local-only commands')) throw new Error(`${agent} installed bundle is not executable.`);

    run(['update', 'cookiy-earn', '--project', '-y'], workspace);
    run(['remove', 'cookiy-earn', '-y'], workspace);
    const afterRemoval = run(['list', '--agent', agent, '--json'], workspace);
    if (afterRemoval.includes('cookiy-earn')) throw new Error(`${agent} still discovers cookiy-earn after uninstall.`);
    console.log(`${agent}: install, repeat install, update, discovery, bundle, and uninstall passed.`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
