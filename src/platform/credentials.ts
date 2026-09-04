import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { credentialFilePath, type CredentialPathOptions } from './paths.js';
import { writePrivateFileAtomic } from './private-file.js';

export const CLI_TOKEN_PATTERN = /^cky_[A-Za-z0-9_-]{50}$/;

export function validateTokenShape(token: string): boolean {
  return CLI_TOKEN_PATTERN.test(token);
}

export async function readToken(options: CredentialPathOptions = {}): Promise<string> {
  let token: string;
  try {
    token = (await readFile(credentialFilePath(options), 'utf8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('Not signed in to Cookiy. First run `node <skill-directory>/scripts/cookiy-earn.js auth save` to save your login token. (ENOENT: no saved credential file)', { cause: error });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Could not read your Cookiy login token. Check the credential file permissions and try again. (${code})`, { cause: error });
    }
    throw error;
  }
  if (!validateTokenShape(token)) throw new Error('Please save your Cookiy login token again by running `node <skill-directory>/scripts/cookiy-earn.js auth save`. (Saved credential is malformed.)');
  return token;
}

export async function saveTokenAtomic(token: string, options: CredentialPathOptions = {}): Promise<string> {
  if (!validateTokenShape(token)) throw new Error('Cookiy CLI tokens must be exactly 54 characters and start with cky_.');
  const destination = credentialFilePath(options);
  const directory = dirname(destination);
  const isWindows = (options.platform ?? process.platform) === 'win32';
  const hasOverride = Boolean((options.env ?? process.env).COOKIY_EARN_CREDENTIALS?.trim());
  let directoryExisted = true;
  try {
    await stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    directoryExisted = false;
  }
  await mkdir(directory, { recursive: true, ...(isWindows ? {} : { mode: 0o700 }) });
  if (!isWindows && (!hasOverride || !directoryExisted)) await chmod(directory, 0o700);
  await writePrivateFileAtomic(destination, `${token}\n`, options.platform ?? process.platform);
  return destination;
}

export async function deleteToken(options: CredentialPathOptions = {}): Promise<boolean> {
  try {
    await rm(credentialFilePath(options));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
