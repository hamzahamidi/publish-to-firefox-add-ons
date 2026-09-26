import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { type OutputName, publishToAmo } from './amo.ts';
import { AMO_BASE } from './client.ts';
import { ActionError } from './errors.ts';
import { checkGeckoId, readManifest } from './manifest.ts';
import { error, getBooleanInput, getInput, info, mask, setOutput, warning } from './runner.ts';
import { credentialNeedles, scanArchive } from './scan.ts';
import { isCrx, readZip } from './zip.ts';

const API_KEY = /^user:([0-9]+):([0-9]+)$/;
const HEX_SECRET = /^[0-9a-f]{32,}$/i;
const SECRET = /^[\x21-\x7e]+$/;
const EMAIL_ID = /^[A-Za-z0-9._-]*@[A-Za-z0-9._-]+$/;
const GUID_ID = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_ARCHIVE_BYTES = 200_000_000;
const MAX_APPROVAL_NOTES = 3_000;

async function main(): Promise<void> {
  const apiKey = getInput('api-key');
  const apiSecret = getInput('api-secret');
  mask(apiKey);
  mask(apiSecret);
  if (!apiKey) throw new ActionError('Input api-key is required.');
  if (!apiSecret) throw new ActionError('Input api-secret is required.');
  if (!API_KEY.test(apiKey)) {
    if (HEX_SECRET.test(apiKey) && API_KEY.test(apiSecret)) throw new ActionError('Inputs api-key and api-secret look swapped.');
    throw new ActionError('Input api-key must look like user:12345:678, the JWT issuer shown on the API Credentials page.');
  }
  if (/^[{["]/.test(apiSecret)) {
    throw new ActionError('Input api-secret looks like JSON. Store the key and the secret as two separate secrets: GitHub cannot reliably mask values taken out of a structured secret.');
  }
  if (!SECRET.test(apiSecret)) throw new ActionError('Input api-secret contains spaces or control characters.');
  if (apiSecret.length > 1024) throw new ActionError('Input api-secret is longer than 1,024 characters.');

  const apiBase = testEndpoint('AMO_API_BASE', AMO_BASE);
  const addonId = getInput('addon-id', { required: true });
  const zipPath = getInput('zip', { required: true });
  const channelInput = getInput('channel', { required: true });
  const sourcePath = getInput('source');
  const releaseNotes = getInput('release-notes');
  const approvalNotes = getInput('approval-notes');
  const wait = getBooleanInput('wait', false);
  const signedXpi = getInput('signed-xpi');
  const waitTimeoutInput = getInput('wait-timeout');
  const dryRun = getBooleanInput('dry-run', false);

  if (!(EMAIL_ID.test(addonId) && addonId.length <= 80) && !GUID_ID.test(addonId)) {
    throw new ActionError('Input addon-id must be the add-on ID from browser_specific_settings.gecko.id, such as name@example.com or {GUID}.');
  }
  const channel = channelInput.toLowerCase();
  if (channel !== 'listed' && channel !== 'unlisted') throw new ActionError(`Input channel must be listed or unlisted, got ${JSON.stringify(channelInput)}.`);
  if (waitTimeoutInput && (!/^\d{1,3}$/.test(waitTimeoutInput) || Number(waitTimeoutInput) < 1 || Number(waitTimeoutInput) > 360)) {
    throw new ActionError(`Input wait-timeout must be a whole number of minutes from 1 to 360, got ${JSON.stringify(waitTimeoutInput)}.`);
  }
  if (waitTimeoutInput && !wait && !signedXpi) throw new ActionError('Input wait-timeout needs wait: true or signed-xpi, because the action only waits when asked.');
  if (signedXpi && channel === 'listed') {
    throw new ActionError('Input signed-xpi downloads the signed file of an unlisted version. A listed version is distributed by addons.mozilla.org.');
  }
  const approvalLength = [...approvalNotes].length;
  if (approvalLength > MAX_APPROVAL_NOTES) {
    throw new ActionError(`Input approval-notes has ${approvalLength.toLocaleString('en-US')} characters; AMO accepts at most 3,000.`);
  }
  if (sourcePath && !sourcePath.toLowerCase().endsWith('.zip')) throw new ActionError('Input source must be a ZIP of your source code.', 'Its file name must end in .zip.');

  const zipLabel = JSON.stringify(zipPath);
  const zip = readArchive(zipPath, zipLabel);
  if (isCrx(zip)) throw new ActionError(`${zipLabel} is a CRX package. Pass the ZIP; the action reads the manifest and scans the entries before uploading.`);
  const archive = readZip(zip, zipLabel);

  const sourceLabel = JSON.stringify(sourcePath);
  const source = sourcePath ? readArchive(sourcePath, sourceLabel) : undefined;
  if (sourcePath && sameFile(zipPath, sourcePath)) throw new ActionError('Input source must name a different file than zip.');
  if (signedXpi && [zipPath, sourcePath].some((path) => path && sameFile(path, signedXpi))) {
    throw new ActionError('Input signed-xpi must name a different file than zip and source.');
  }
  const sourceArchive = source ? readZip(source, sourceLabel) : undefined;

  const needles = credentialNeedles(apiKey, apiSecret);
  const entries = scanArchive(archive, needles);
  const sourceEntries = sourceArchive ? scanArchive(sourceArchive, needles) : undefined;
  const manifest = readManifest(archive);
  checkGeckoId(manifest, addonId, zipLabel);
  info(`The ZIP holds version ${manifest.version} of ${addonId}.`);
  info(
    sourceEntries === undefined
      ? `Checked ${entries} entries of the ZIP: it does not contain the API key or secret.`
      : `Checked ${entries} entries of the ZIP and ${sourceEntries} entries of the source ZIP: neither contains the API key or secret.`,
  );
  setOutput('version', manifest.version);

  const outputs: Record<OutputName, (value: string) => void> = {
    result: (value) => setOutput('result', value),
    state: (value) => setOutput('state', value),
    'version-id': (value) => setOutput('version-id', value),
    'edit-url': (value) => setOutput('edit-url', value),
    'signed-xpi': (value) => setOutput('signed-xpi', value),
  };
  await publishToAmo({
    apiKey,
    apiSecret,
    addonId,
    version: manifest.version,
    channel,
    zip,
    zipName: uploadName(zipPath),
    source,
    sourceName: source ? uploadName(sourcePath) : undefined,
    releaseNotes: releaseNotes || undefined,
    approvalNotes: approvalNotes || undefined,
    wait,
    waitTimeoutMinutes: waitTimeoutInput ? Number(waitTimeoutInput) : undefined,
    signedXpi: signedXpi || undefined,
    dryRun,
    apiBase,
    log: info,
    warn: warning,
    mask,
    output: (name, value) => outputs[name](value),
  });
}

function readArchive(path: string, label: string): Buffer {
  try {
    if (statSync(path).size > MAX_ARCHIVE_BYTES) throw new ActionError(`${label} is larger than 200,000,000 bytes, the largest file AMO accepts.`);
    return readFileSync(path);
  } catch (cause) {
    if (cause instanceof ActionError) throw cause;
    const { code, message } = cause as NodeJS.ErrnoException;
    throw new ActionError(`Cannot read ${label}: ${code === 'ENOENT' ? 'no such file' : message}.`);
  }
}

function sameFile(existing: string, other: string): boolean {
  if (resolve(existing) === resolve(other)) return true;
  const a = statSync(existing, { bigint: true });
  const b = statSync(other, { bigint: true, throwIfNoEntry: false });
  return b !== undefined && a.dev === b.dev && a.ino === b.ino;
}

function uploadName(path: string): string {
  const name = basename(path).replace(/[^A-Za-z0-9._-]/g, '_');
  const extension = /\.(zip|xpi)$/i.exec(name);
  return extension ? `${name.slice(0, -4)}${extension[0].toLowerCase()}` : `${name}.zip`;
}

function testEndpoint(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ActionError(`${name} is not a URL.`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ActionError(`${name} is a test setting and may only point to http://127.0.0.1, http://localhost or http://[::1].`);
  }
  return value.replace(/\/+$/, '');
}

main().catch((cause: unknown) => {
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${(cause as Error | undefined)?.stack ?? cause}`);
  process.exitCode = 1;
});
