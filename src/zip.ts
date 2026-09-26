import { crc32, inflateRawSync } from 'node:zlib';
import { ActionError } from './errors.ts';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
export const MAX_ENTRY_BYTES = 100 * 1024 ** 2;
export const MAX_TOTAL_BYTES = 250 * 1024 ** 2;
const UNREADABLE = 'The action cannot read or scan it, and never uploads what it has not scanned.';

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  centralOffset: number;
  centralEnd: number;
}

export interface ZipArchive {
  label: string;
  bytes: Buffer;
  entries: ZipEntry[];
  read(entry: ZipEntry): Buffer;
  locate(offset: number): string;
}

export function isCrx(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'Cr24';
}

export function readZip(bytes: Buffer, label: string): ZipArchive {
  if (isCrx(bytes)) throw new ActionError(`${label} is a CRX package, not a ZIP.`);
  const end = findEndOfCentralDirectory(bytes, label);
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new ActionError(`${label} is a ZIP64 archive. ${UNREADABLE}`);
  }
  if (start + size > end) throw new ActionError(`${label} is not a valid ZIP file (central directory out of range).`);

  const entries: ZipEntry[] = [];
  let total = 0;
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ActionError(`${label} is not a valid ZIP file (damaged central directory).`);
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const centralEnd = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const entry: ZipEntry = {
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      crc: bytes.readUInt32LE(offset + 16),
      compressedSize: bytes.readUInt32LE(offset + 20),
      size: bytes.readUInt32LE(offset + 24),
      localOffset: bytes.readUInt32LE(offset + 42),
      name: bytes.toString('utf8', offset + 46, offset + 46 + nameLength),
      centralOffset: offset,
      centralEnd,
    };
    checkEntry(entry, label);
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new ActionError(`${label} holds more than 250 MiB once uncompressed, the most AMO accepts.`);
    entries.push(entry);
    offset = centralEnd;
  }

  return {
    label,
    bytes,
    entries,
    read: (entry) => extract(bytes, entry, label),
    locate(position) {
      const entry = entries.find((each) => (position >= each.centralOffset && position < each.centralEnd) || (position >= each.localOffset && position < dataEnd(bytes, each)));
      return entry ? `entry ${JSON.stringify(entry.name)}` : 'the archive comment or headers';
    },
  };
}

function checkEntry(entry: ZipEntry, label: string): void {
  const name = JSON.stringify(entry.name);
  if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localOffset === 0xffffffff) {
    throw new ActionError(`Entry ${name} of ${label} uses ZIP64. ${UNREADABLE}`);
  }
  if (entry.flags & 1) throw new ActionError(`Entry ${name} of ${label} is encrypted. ${UNREADABLE}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ActionError(`Entry ${name} of ${label} uses ZIP compression method ${entry.method}. ${UNREADABLE} AMO accepts only stored and deflated entries.`);
  }
  if (entry.name.includes('\\') || entry.name.includes('../') || entry.name.startsWith('/') || /[\x00-\x1f\x7f]/.test(entry.name)) {
    throw new ActionError(`Entry ${name} of ${label} has a name AMO refuses: no backslash, "../", leading "/" or control character is allowed.`);
  }
  if (entry.size > MAX_ENTRY_BYTES) throw new ActionError(`Entry ${name} of ${label} is larger than 100 MiB once uncompressed, the most AMO accepts.`);
}

function findEndOfCentralDirectory(bytes: Buffer, label: string): number {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= lowest; offset--) {
    if (bytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ActionError(`${label} is not a valid ZIP file.`);
}

function dataStart(bytes: Buffer, entry: ZipEntry): number {
  const header = entry.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_FILE_HEADER) return -1;
  return header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
}

function dataEnd(bytes: Buffer, entry: ZipEntry): number {
  const start = dataStart(bytes, entry);
  return start < 0 ? entry.localOffset : start + entry.compressedSize;
}

function extract(bytes: Buffer, entry: ZipEntry, label: string): Buffer {
  const name = JSON.stringify(entry.name);
  const start = dataStart(bytes, entry);
  if (start < 0) throw new ActionError(`${label} is not a valid ZIP file (damaged entry ${name}).`);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ActionError(`${label} is truncated (entry ${name}).`);

  let content = data;
  if (entry.method === 8) {
    try {
      content = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ActionError(`Entry ${name} of ${label} could not be decompressed to its declared size. The ZIP is damaged.`);
    }
  }
  if (content.length !== entry.size || crc32(content) !== entry.crc) {
    throw new ActionError(`Entry ${name} of ${label} fails its checksum. The ZIP is damaged.`);
  }
  return content;
}
