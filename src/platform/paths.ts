import os from 'node:os';
import path from 'node:path';

export interface CredentialPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

export function credentialFilePath(options: CredentialPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathModule = platform === 'win32' ? path.win32 : path;
  if (env.COOKIY_EARN_CREDENTIALS?.trim()) return pathModule.resolve(env.COOKIY_EARN_CREDENTIALS.trim());
  const homeDir = options.homeDir ?? os.homedir();
  return pathModule.join(homeDir, '.cookiy', 'earn-token.txt');
}
