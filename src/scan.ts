import { ActionError } from './errors.ts';
import type { ZipArchive } from './zip.ts';

export interface Needle {
  name: string;
  text: string;
  bytes: Buffer;
}

export function credentialNeedles(apiKey: string, apiSecret: string): Needle[] {
  return [
    { name: 'API key', text: apiKey, bytes: Buffer.from(apiKey, 'utf8') },
    { name: 'API secret', text: apiSecret, bytes: Buffer.from(apiSecret, 'utf8') },
  ];
}

export function scanArchive(archive: ZipArchive, needles: Needle[]): number {
  const found = (needle: Needle, where: string) =>
    new ActionError(
      `The ${needle.name} appears in ${Buffer.from(where).includes(needle.bytes) ? 'the name of an entry' : where} of ${archive.label}. AMO revokes a key it finds in an upload. Remove it from the build; nothing was sent.`,
    );
  for (const needle of needles) {
    const offset = archive.bytes.indexOf(needle.bytes);
    if (offset >= 0) throw found(needle, archive.locate(offset));
  }
  for (const entry of archive.entries) {
    const content = archive.read(entry);
    // AMO searches each entry decoded as UTF-8 with errors='ignore', which drops the invalid bytes that Node replaces with U+FFFD.
    const decoded = content.toString('utf8').replaceAll('�', '');
    for (const needle of needles) {
      if (content.includes(needle.bytes) || decoded.includes(needle.text)) throw found(needle, `entry ${JSON.stringify(entry.name)}`);
    }
  }
  return archive.entries.length;
}
