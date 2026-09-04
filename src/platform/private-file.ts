import { chmod, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export async function writePrivateFileAtomic(
  destination: string,
  data: string | Uint8Array,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const isWindows = platform === 'win32';
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', isWindows ? undefined : 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!isWindows) await chmod(temporary, 0o600);
    await rename(temporary, destination);
    if (!isWindows) await chmod(destination, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
