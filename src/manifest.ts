import { ActionError } from './errors.ts';
import type { ZipArchive } from './zip.ts';

const VERSION_PATTERN = /^[-+*.\w]{1,255}$/;

export interface AddonManifest {
  version: string;
  geckoId: string | undefined;
  ignoredApplicationsId: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function isAmoVersion(version: unknown): version is string {
  return typeof version === 'string' && VERSION_PATTERN.test(version);
}

export function stripComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
    } else out += char;
  }
  return out;
}

export function readManifest(archive: ZipArchive): AddonManifest {
  const { entries, label } = archive;
  const matches = entries.filter((entry) => entry.name === 'manifest.json');
  if (matches.length === 0) {
    const nested = entries.find((entry) => entry.name.endsWith('/manifest.json'));
    throw new ActionError(
      nested
        ? `${label} has no manifest.json at its root, only ${JSON.stringify(nested.name)}. Zip the contents of the extension folder, not the folder itself.`
        : `${label} has no manifest.json at its root.`,
    );
  }
  if (matches.length > 1) throw new ActionError(`${label} contains manifest.json more than once.`);

  let manifest: unknown;
  try {
    manifest = JSON.parse(stripComments(archive.read(matches[0]!).toString('utf8').replace(/^﻿/, '')));
  } catch (error) {
    if (error instanceof ActionError) throw error;
    const place = /line (\d+) column (\d+)/.exec((error as Error).message);
    throw new ActionError(`manifest.json in ${label} is not valid JSON${place ? ` at line ${place[1]}, column ${place[2]}` : ''}.`);
  }
  if (!isObject(manifest)) throw new ActionError(`manifest.json in ${label} is not a JSON object.`);
  if (!isAmoVersion(manifest.version)) {
    throw new ActionError(
      `manifest.json in ${label} has version ${JSON.stringify(manifest.version)}, which AMO does not accept.`,
      'AMO takes 1 to 255 characters of ASCII letters, digits and - + * . _',
    );
  }

  const geckoIdOf = (settings: unknown) => {
    const id = isObject(settings) && isObject(settings.gecko) ? settings.gecko.id : undefined;
    return typeof id === 'string' && id ? id : undefined;
  };
  const hasSettings = manifest.browser_specific_settings !== undefined;
  const applicationsId = geckoIdOf(manifest.applications);
  const geckoId = hasSettings ? geckoIdOf(manifest.browser_specific_settings) : applicationsId;
  return { version: manifest.version, geckoId, ignoredApplicationsId: hasSettings && !geckoId && applicationsId !== undefined };
}

export function checkGeckoId(manifest: AddonManifest, addonId: string, label: string): void {
  if (manifest.ignoredApplicationsId) {
    throw new ActionError(
      `manifest.json in ${label} has applications.gecko.id, but AMO ignores applications when browser_specific_settings exists. Move the ID to browser_specific_settings.gecko.id.`,
    );
  }
  if (!manifest.geckoId) {
    throw new ActionError(
      `manifest.json in ${label} has no browser_specific_settings.gecko.id, so the action cannot confirm this package belongs to ${addonId}. AMO would attach it to whatever add-on the request names.`,
      'Add the ID; it is required for Manifest V3 and harmless for Manifest V2.',
    );
  }
  if (manifest.geckoId !== addonId) {
    throw new ActionError(`${label} is for ${JSON.stringify(manifest.geckoId)}, but addon-id is ${JSON.stringify(addonId)}. Nothing was sent.`);
  }
}
