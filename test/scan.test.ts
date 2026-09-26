import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { credentialNeedles, scanArchive } from '../src/scan.ts';
import { readZip } from '../src/zip.ts';
import { API_KEY, API_SECRET, addonZip, makeZip, sourceZip, type ZipFile } from './helpers.ts';

const needles = credentialNeedles(API_KEY, API_SECRET);

function scan(files: ZipFile[], options: { comment?: string } = {}, label = '"ext.zip"') {
  return () => scanArchive(readZip(makeZip(files, options), label), needles);
}

function fails(action: () => unknown, pattern: RegExp) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ActionError);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(API_SECRET) && !error.message.includes(API_KEY), 'the message never contains a credential');
    return true;
  });
}

describe('scanArchive', () => {
  it('counts the entries of a clean archive', () => {
    assert.equal(scanArchive(readZip(addonZip('1.0'), 'x'), needles), 2);
    assert.equal(scanArchive(readZip(sourceZip(), 'x'), needles), 2);
  });

  it('finds the secret in a deflated entry, which the raw bytes do not show', () => {
    fails(scan([{ name: 'dist/config.js', data: `const secret = "${API_SECRET}";`.repeat(3) }]), /^The API secret appears in entry "dist\/config\.js" of "ext\.zip"\. AMO revokes a key it finds in an upload\. Remove it from the build; nothing was sent\.$/);
  });

  it('finds the secret in a stored entry, an entry name and the archive comment', () => {
    fails(scan([{ name: 'a.js', data: `x${API_SECRET}`, method: 0 }]), /API secret appears in entry "a\.js"/);
    fails(scan([{ name: `${API_SECRET}.txt`, data: 'x' }]), /API secret appears in the name of an entry of "ext\.zip"/);
    fails(scan([{ name: 'a.js', data: 'x' }], { comment: API_SECRET }), /API secret appears in the archive comment or headers/);
  });

  it('finds the key alone in an entry shorter than the 64 bytes AMO skips', () => {
    fails(scan([{ name: 'k.txt', data: API_KEY }]), /API key appears in entry "k\.txt"/);
  });

  it('names the source ZIP when the secret is in it', () => {
    fails(scan([{ name: 'src/.env', data: `AMO_SECRET=${API_SECRET}` }], {}, '"source.zip"'), /entry "src\/\.env" of "source\.zip"/);
  });

  it('refuses an entry whose declared size differs from what it inflates to', () => {
    assert.throws(scan([{ name: 'a.js', data: 'abcdefghij'.repeat(10), size: 20 }]), /could not be decompressed to its declared size/);
  });
});
