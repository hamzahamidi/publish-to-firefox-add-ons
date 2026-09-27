import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { type AddonManifest, checkGeckoId, isAmoVersion, readManifest, stripComments } from '../src/manifest.ts';
import { readZip } from '../src/zip.ts';
import { ADDON_ID, addonZip, makeZip } from './helpers.ts';

const manifestZip = (text: string) => readZip(makeZip([{ name: 'manifest.json', data: text }]), '"ext.zip"');
const read = (manifest: Record<string, unknown>) => readManifest(manifestZip(JSON.stringify({ manifest_version: 2, name: 'x', version: '1.0', ...manifest })));

function fails(action: () => unknown, pattern: RegExp) {
  assert.throws(action, (error) => error instanceof ActionError && pattern.test(error.details ? `${error.message}\n${error.details}` : error.message));
}

describe('stripComments', () => {
  it('removes line and block comments outside strings', () => {
    assert.deepEqual(JSON.parse(stripComments('{\n  // name\n  "a": 1, /* the\n block */ "b": "x"\n}')), { a: 1, b: 'x' });
  });

  it('keeps comment markers and escaped quotes inside strings', () => {
    assert.deepEqual(JSON.parse(stripComments('{"url": "https://example.com/*x*/", "q": "say \\"//\\" here"} // end')), { url: 'https://example.com/*x*/', q: 'say "//" here' });
  });

  it('drops an unterminated block comment to the end', () => {
    assert.equal(stripComments('{} /* open'), '{} ');
  });
});

describe('readManifest', () => {
  it('reads the version and the Gecko ID from browser_specific_settings', () => {
    assert.deepEqual(readManifest(readZip(addonZip('1.4.0'), 'x')), { version: '1.4.0', geckoId: ADDON_ID, ignoredApplicationsId: false, geckoAndroid: false });
  });

  it('notes a gecko_android block, which makes AMO take the Android range from the manifest', () => {
    assert.equal(read({ browser_specific_settings: { gecko: { id: 'a@b' }, gecko_android: {} } }).geckoAndroid, true);
    assert.equal(read({ browser_specific_settings: { gecko: { id: 'a@b' }, gecko_android: true } }).geckoAndroid, false);
  });

  it('accepts a byte order mark and comments, as AMO does', () => {
    const text = `\uFEFF{\n // comment\n "version": "2.0", /* id */ "browser_specific_settings": {"gecko": {"id": "a@b"}}}`;
    assert.equal(readManifest(manifestZip(text)).geckoId, 'a@b');
  });

  it('reads applications only when browser_specific_settings is absent', () => {
    assert.equal(read({ applications: { gecko: { id: 'old@x' } } }).geckoId, 'old@x');
    assert.deepEqual(read({ browser_specific_settings: { gecko: { id: 'new@x' } }, applications: { gecko: { id: 'old@x' } } }).geckoId, 'new@x');
  });

  it('lets browser_specific_settings win even without gecko, and flags the ignored ID', () => {
    const manifest = read({ browser_specific_settings: { safari: {} }, applications: { gecko: { id: 'old@x' } } });
    assert.equal(manifest.geckoId, undefined);
    assert.equal(manifest.ignoredApplicationsId, true);
  });

  it('points at a manifest inside a folder', () => {
    fails(() => readManifest(readZip(makeZip([{ name: 'dist/manifest.json', data: '{}' }]), '"ext.zip"')), /only "dist\/manifest\.json"\. Zip the contents of the extension folder/);
  });

  it('fails without a manifest, with two, with invalid JSON and with a JSON array', () => {
    fails(() => readManifest(readZip(makeZip([{ name: 'a.js', data: '' }]), '"ext.zip"')), /has no manifest\.json at its root\.$/);
    fails(
      () =>
        readManifest(
          readZip(
            makeZip([
              { name: 'manifest.json', data: '{}' },
              { name: 'manifest.json', data: '{}' },
            ]),
            '"ext.zip"',
          ),
        ),
      /more than once/,
    );
    fails(() => readManifest(manifestZip('{"version": ')), /is not valid JSON/);
    fails(() => readManifest(manifestZip('[]')), /is not a JSON object/);
  });

  it('reports where the JSON breaks without quoting the manifest', () => {
    for (const text of ['{"version": "1.0", "a": cabbage}', '{"version": "1.0",\n "a": 1cabbage}', '{"version": "1.0", "a": "cabbage']) {
      fails(() => readManifest(manifestZip(text)), /^manifest\.json in "ext\.zip" is not valid JSON( at line \d+, column \d+)?\.$/);
      fails(() => readManifest(manifestZip(text)), /^(?![\s\S]*abba)/);
    }
  });

  it('applies the AMO version rule and nothing stricter', () => {
    for (const version of ['1.0', '1.0.0-beta+build.1', '2*', 'a_b', 'x'.repeat(255)]) assert.equal(read({ version }).version, version);
    for (const version of ['', 'x'.repeat(256), '1.0 beta', '1.0/2', 'é', 1]) fails(() => read({ version }), /which AMO does not accept/);
    assert.equal(isAmoVersion('1.0'), true);
    assert.equal(isAmoVersion(undefined), false);
  });
});

describe('checkGeckoId', () => {
  const manifest = (geckoId: string | undefined, ignoredApplicationsId = false): AddonManifest => ({ version: '1.0', geckoId, ignoredApplicationsId, geckoAndroid: false });

  it('accepts the matching ID', () => {
    checkGeckoId(manifest('a@x'), 'a@x', '"ext.zip"');
  });

  it('explains the ID that AMO ignores', () => {
    fails(() => checkGeckoId(manifest(undefined, true), 'a@x', '"ext.zip"'), /AMO ignores applications when browser_specific_settings exists/);
  });

  it('refuses a manifest without an ID with a hint', () => {
    fails(() => checkGeckoId(manifest(undefined), 'a@x', '"ext.zip"'), /no browser_specific_settings\.gecko\.id, so the action cannot confirm this package belongs to a@x.*\nAdd the ID; it is required for Manifest V3/s);
  });

  it('refuses an ID that differs, even in letter case', () => {
    fails(() => checkGeckoId(manifest('A@x'), 'a@x', '"ext.zip"'), /"ext\.zip" is for "A@x", but addon-id is "a@x"\. Nothing was sent\./);
  });
});
