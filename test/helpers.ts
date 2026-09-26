import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: string | Buffer;
  method?: number;
  flags?: number;
  crc?: number;
  size?: number;
}

export function makeZip(files: ZipFile[], { comment = '' }: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const method = file.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const flags = file.flags ?? 0x0800;
    const crc = file.crc ?? crc32(data);
    const size = file.size ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}

export function unzip(zip: Buffer): Map<string, Buffer> {
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a ZIP');
  const files = new Map<string, Buffer>();
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const method = zip.readUInt16LE(offset + 10);
    const packedLength = zip.readUInt32LE(offset + 20);
    const local = zip.readUInt32LE(offset + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + packedLength);
    const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    if (crc32(data) !== zip.readUInt32LE(offset + 16)) throw new Error(`bad CRC in ${name}`);
    files.set(name, data);
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return files;
}

export const ADDON_ID = 'my-extension@example.com';
export const API_KEY = 'user:12345:67';
export const API_SECRET = '4f1c2e8a9b7d6c5e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e';
export const ACCOUNT = 12345;

export interface AddonZipOptions {
  id?: string | null;
  manifest?: Record<string, unknown>;
  files?: ZipFile[];
  method?: number;
}

export function addonManifest(version: string, { id = ADDON_ID, manifest = {} }: AddonZipOptions = {}): Record<string, unknown> {
  return { manifest_version: 3, name: 'Test add-on', version, ...(id === null ? {} : { browser_specific_settings: { gecko: { id } } }), ...manifest };
}

export function addonZip(version: string, options: AddonZipOptions = {}): Buffer {
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify(addonManifest(version, options)), method: options.method },
    { name: 'background.js', data: 'browser.runtime.onInstalled.addListener(() => {});\n', method: options.method },
    ...(options.files ?? []),
  ]);
}

export function sourceZip(files: ZipFile[] = [{ name: 'src/background.ts', data: 'browser.runtime.onInstalled.addListener(() => {});\n' }]): Buffer {
  return makeZip([{ name: 'package.json', data: '{"name":"test-add-on","scripts":{"build":"tsc"}}' }, ...files]);
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  partial?: boolean;
}

export interface RecordedRequest {
  key: string;
  auth: string | undefined;
  contentType: string | undefined;
  userAgent: string | undefined;
  accept: string | undefined;
  size: number;
  body: string;
}

export interface MockStore {
  base: string;
  requests: RecordedRequest[];
  on(key: string, ...replies: Reply[]): void;
  reset(): void;
  close(): Promise<void>;
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

export async function startMockStore({ onRequest }: { onRequest?: (request: RecordedRequest, requests: RecordedRequest[]) => void } = {}): Promise<MockStore> {
  const routes = new Map<string, Reply[]>();
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = Buffer.concat(chunks);
      const key = `${req.method} ${req.url}`;
      const request: RecordedRequest = {
        key,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent'],
        accept: req.headers.accept,
        size: payload.length,
        body: payload.toString(),
      };
      requests.push(request);
      onRequest?.(request, requests);
      const queue = routes.get(key);
      const reply: Reply = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? { status: 404, body: { detail: `no mock route for ${key}` } };
      if (reply.partial) {
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        res.write('{"sta');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    on(key, ...replies) {
      routes.set(key, replies);
    },
    reset() {
      routes.clear();
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
