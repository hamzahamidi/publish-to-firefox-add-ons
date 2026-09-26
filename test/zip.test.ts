import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { isCrx, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, readZip, type ZipArchive } from '../src/zip.ts';
import { addonFiles, addonZip, divergentZip, makeZip } from './helpers.ts';

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

  for (const name of ['dist\\a.js', '../evil.js', 'a/../../b', '/etc/passwd', 'bad\u0001name', 'tab\tname', '..', 'x\u0085y', 'a\u200bb.js', 'a\u2060b.js', 'a\ue000.js']) {
    it(`refuses the entry name ${JSON.stringify(name).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}, as AMO does`, () => {
      fails(() => readZip(makeZip([{ name, data: 'x' }]), '"x"'), /has a name AMO refuses/);
    });
  }

  it('accepts names AMO accepts, including a name without the UTF-8 flag that AMO reads as cp437', () => {
    const names = ['é.js', '日本語.txt', '😀.png', '_locales/pt_BR/messages.json', 'a..b.js', '.hidden', 'a/..'];
    assert.deepEqual(
      readZip(makeZip(names.map((name) => ({ name, data: 'x' }))), '"x"').entries.map((entry) => entry.name),
      names,
    );
    assert.equal(readZip(makeZip([{ name: 'x\u0085y', data: 'x', flags: 0 }]), '"x"').entries.length, 1);
    fails(() => readZip(makeZip([{ name: 'bad\u007fname', data: 'x', flags: 0 }]), '"x"'), /has a name AMO refuses/);
  });

  it('refuses an entry over 100 MiB and a total of 250 MiB or more from the declared sizes, without inflating anything', () => {
    fails(() => readZip(makeZip([{ name: 'huge.bin', data: 'x', size: MAX_ENTRY_BYTES + 1 }]), '"x"'), /Entry "huge\.bin" of "x" is larger than 100 MiB/);
    readZip(makeZip([{ name: 'edge.bin', data: 'x', size: MAX_ENTRY_BYTES }]), '"x"');
    const sized = (last: number) => makeZip([MAX_ENTRY_BYTES, MAX_ENTRY_BYTES, last].map((size, i) => ({ name: `${i}.bin`, data: 'x', size })));
    fails(() => readZip(sized(MAX_TOTAL_BYTES - 2 * MAX_ENTRY_BYTES), '"x"'), /^"x" holds 250 MiB or more once uncompressed\. AMO accepts less than 250 MiB\.$/);
    assert.equal(readZip(sized(MAX_TOTAL_BYTES - 2 * MAX_ENTRY_BYTES - 1), '"x"').entries.length, 3);
  });

  it('reads the central directory by its size, as AMO does, and refuses an archive whose end record disagrees', () => {
    const files = addonFiles('1.0.0', { files: [{ name: 'dist/config.js', data: 'hidden' }] });
    const cases: Array<[Parameters<typeof divergentZip>[0], RegExp]> = [
      ['low-count', /^"x" is not a valid ZIP file \(its end record does not count the 3 entries of its central directory\)\. The action cannot read or scan it/],
      ['zip64-locator', /^"x" is a ZIP64 archive\. The action cannot read or scan it/],
      ['shifted-cd', /^"x" is not a valid ZIP file \(data between the central directory and its end record\)\. The action cannot read or scan it/],
    ];
    for (const [kind, pattern] of cases) fails(() => readZip(divergentZip(kind, files), '"x"'), pattern);
    const zip = makeZip(files);
    const oneField = Buffer.from(zip);
    oneField.writeUInt16LE(2, zip.length - 22 + 8);
    fails(() => readZip(oneField, '"x"'), /its end record does not count the 3 entries/);
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
    const overlong = Buffer.from(zip);
    overlong.writeUInt16LE(200, overlong.readUInt32LE(end + 16) + 28);
    fails(() => readZip(overlong, '"x"'), /damaged central directory/);
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
