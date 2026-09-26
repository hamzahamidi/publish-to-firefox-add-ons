import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AmoClient, Request } from './client.ts';
import { logSafe } from './decode.ts';
import { ActionError } from './errors.ts';
import { readManifest } from './manifest.ts';
import { readZip } from './zip.ts';

const SIGNATURE_ENTRIES = ['META-INF/mozilla.rsa', 'META-INF/mozilla.sf', 'META-INF/manifest.mf'];
const NOT_WRITTEN = 'Nothing was written.';

export interface DownloadOptions {
  client: AmoClient;
  apiBase: string;
  url: string | undefined;
  hash: string | undefined;
  size: number | undefined;
  target: string;
  addonId: string;
  version: string;
}

export async function downloadSignedFile({ client, apiBase, url, hash, size, target, addonId, version }: DownloadOptions): Promise<void> {
  const base = new URL(apiBase);
  let location: URL | undefined;
  try {
    location = new URL(url ?? '');
  } catch {
    location = undefined;
  }
  if (!location || location.origin !== base.origin) {
    throw new ActionError(`AMO returned a download URL on ${location ? location.host : logSafe(url)}. The action sends the JWT to ${base.host} only.`);
  }
  if (!hash || !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new ActionError('AMO gave no SHA-256 hash for the signed file; the action does not write an unverified file.');

  const request: Request = { method: 'GET', path: location.href, file: true, binary: true };
  const reply = await client.read(request);
  if (reply.status === 404) {
    throw client.failure(request, reply, 'AMO refused the signed file. Only an author of the add-on can download an unlisted file; the developer role is enough.');
  }
  if (reply.status !== 200) throw client.failure(request, reply);
  const bytes = reply.bytes;
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== hash) throw new ActionError(`The downloaded file has SHA-256 ${digest.slice(7)}, but AMO reported ${hash.slice(7)}. ${NOT_WRITTEN}`);
  if (size !== undefined && bytes.length !== size) throw new ActionError(`The downloaded file has ${bytes.length} bytes, but AMO reported ${size}. ${NOT_WRITTEN}`);

  const archive = readZip(bytes, 'The signed file');
  const names = new Set(archive.entries.map((entry) => entry.name));
  const missing = SIGNATURE_ENTRIES.filter((name) => !names.has(name));
  if (missing.length > 0) throw new ActionError(`The signed file has no ${missing.join(', ')}, so Mozilla did not sign it. ${NOT_WRITTEN}`);
  const manifest = readManifest(archive);
  if (manifest.geckoId !== addonId || manifest.version !== version) {
    throw new ActionError(`The signed file holds version ${manifest.version} of ${logSafe(manifest.geckoId ?? null)}, not ${version} of ${addonId}. ${NOT_WRITTEN}`);
  }

  const folder = dirname(target);
  const temporary = join(folder, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
  } catch (cause) {
    if (existsSync(temporary)) rmSync(temporary);
    throw new ActionError(`Cannot write ${JSON.stringify(target)}: ${(cause as Error).message}.`);
  }
}
