import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { isCrx, MAX_ENTRY_BYTES, readZip, type ZipArchive } from '../src/zip.ts';
import { addonZip, makeZip } from './helpers.ts';

function fails(action: () => unknown, pattern: RegExp) {
  assert.throws(action, (error) => error instanceof ActionError && pattern.test(error.message));
}

const readAll = (archive: ZipArchive) => archive.entries.map((entry) => archive.read(entry).toString());

describe('readZip', () => {
  it('lists and reads stored and deflated entries', () => {
    const archive = readZip(
      makeZip([
        { name: 'a.txt', data: 'stored', method: 0 },
        { name: 'dir/', data: '' },
        { name: 'b.txt', data: 'deflated' },
      ]),
      '"ext.zip"',
    );
    assert.deepEqual(
      archive.entries.map((entry) => entry.name),
      ['a.txt', 'dir/', 'b.txt'],
    );
    assert.deepEqual(readAll(archive), ['stored', '', 'deflated']);
  });

  it('finds the central directory behind an archive comment', () => {
    assert.equal(readZip(makeZip([{ name: 'a', data: 'x' }], { comment: 'built by CI' }), 'x').entries.length, 1);
  });

  it('refuses a CRX and anything that is not a ZIP', () => {
    const crx = Buffer.concat([Buffer.from('Cr24'), Buffer.alloc(8), addonZip('1.0')]);
    assert.equal(isCrx(crx), true);
    assert.equal(isCrx(Buffer.from('Cr')), false);
    fails(() => readZip(crx, '"ext.crx"'), /"ext\.crx" is a CRX package, not a ZIP\./);
    fails(() => readZip(Buffer.from('not a zip at all, just some text that is long enough'), '"x"'), /is not a valid ZIP file\.$/);
  });

  it('refuses a ZIP64 archive and a ZIP64 entry', () => {
    const zip = makeZip([{ name: 'a', data: 'x' }]);
    const end = zip.length - 22;
    const zip64 = Buffer.from(zip);
    zip64.writeUInt16LE(0xffff, end + 10);
    fails(() => readZip(zip64, '"x"'), /is a ZIP64 archive\. The action cannot read or scan it/);
    fails(() => readZip(makeZip([{ name: 'big', data: 'x', size: 0xffffffff }]), '"x"'), /Entry "big" of "x" uses ZIP64/);
  });

  it('refuses an encrypted entry and compression methods other than stored and deflated', () => {
    fails(() => readZip(makeZip([{ name: 'secret.js', data: 'x', flags: 0x0801 }]), '"x"'), /Entry "secret\.js" of "x" is encrypted\./);
    fails(() => readZip(makeZip([{ name: 'bz.js', data: 'x', method: 12 }]), '"x"'), /uses ZIP compression method 12\..*AMO accepts only stored and deflated entries/);
  });

  for (const name of ['dist\\a.js', '../evil.js', 'a/../../b', '/etc/passwd', 'bad\u0001name', 'tab\tname']) {
    it(`refuses the entry name ${JSON.stringify(name)}, as AMO does`, () => {
      fails(() => readZip(makeZip([{ name, data: 'x' }]), '"x"'), /has a name AMO refuses/);
    });
  }

  it('refuses an entry over 100 MiB and a total over 250 MiB from the declared sizes, without inflating anything', () => {
    fails(() => readZip(makeZip([{ name: 'huge.bin', data: 'x', size: MAX_ENTRY_BYTES + 1 }]), '"x"'), /Entry "huge\.bin" of "x" is larger than 100 MiB/);
    readZip(makeZip([{ name: 'edge.bin', data: 'x', size: MAX_ENTRY_BYTES }]), '"x"');
    const files = ['a', 'b', 'c'].map((name) => ({ name, data: 'x', size: 90 * 1024 ** 2 }));
    fails(() => readZip(makeZip(files), '"x"'), /holds more than 250 MiB once uncompressed/);
  });

  it('refuses a damaged or out of range central directory', () => {
    const zip = makeZip([{ name: 'a', data: 'x' }]);
    const end = zip.length - 22;
    const damaged = Buffer.from(zip);
    damaged.writeUInt32LE(0, damaged.readUInt32LE(end + 16));
    fails(() => readZip(damaged, '"x"'), /damaged central directory/);
    const outOfRange = Buffer.from(zip);
    outOfRange.writeUInt32LE(zip.length, end + 16);
    fails(() => readZip(outOfRange, '"x"'), /central directory out of range/);
  });

  it('names the entry that fails its CRC, is truncated, or inflates past its declared size', () => {
    fails(() => readAll(readZip(makeZip([{ name: 'a.js', data: 'hello', crc: 1 }]), '"x"')), /Entry "a\.js" of "x" fails its checksum/);
    fails(() => readAll(readZip(makeZip([{ name: 'a.js', data: 'hello', method: 0, size: 4 }]), '"x"')), /Entry "a\.js" of "x" fails its checksum/);
    fails(() => readAll(readZip(makeZip([{ name: 'a.js', data: 'hello world, hello world', size: 3 }]), '"x"')), /could not be decompressed to its declared size/);
    const zip = makeZip([{ name: 'a.js', data: 'hello', method: 0 }]);
    const archive = readZip(zip, '"x"');
    fails(() => archive.read({ ...archive.entries[0]!, compressedSize: zip.length }), /"x" is truncated \(entry "a\.js"\)/);
    fails(() => archive.read({ ...archive.entries[0]!, localOffset: 3 }), /damaged entry "a\.js"/);
  });

  it('locates an offset in an entry, its central record or the archive comment', () => {
    const zip = makeZip([{ name: 'a.js', data: 'needle', method: 0 }], { comment: 'comment needle' });
    const archive = readZip(zip, '"x"');
    assert.equal(archive.locate(zip.indexOf('needle')), 'entry "a.js"');
    assert.equal(archive.locate(archive.entries[0]!.centralOffset + 47), 'entry "a.js"');
    assert.equal(archive.locate(zip.lastIndexOf('needle')), 'the archive comment or headers');
    assert.equal(archive.locate(0), 'entry "a.js"');
  });
});
