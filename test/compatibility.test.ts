import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compatibilityMatches, describeCompatibility, parseCompatibility } from '../src/compatibility.ts';
import { ActionError } from '../src/errors.ts';

function fails(input: string, pattern: RegExp) {
  assert.throws(() => parseCompatibility(input), (error) => error instanceof ActionError && pattern.test(error.message));
}

describe('parseCompatibility', () => {
  it('returns nothing for an empty input, so AMO keeps what it reads from the manifest', () => {
    assert.equal(parseCompatibility(''), undefined);
  });

  it('reads an array of applications and an object of ranges', () => {
    assert.deepEqual(parseCompatibility('["firefox", "android"]'), ['firefox', 'android']);
    assert.deepEqual(parseCompatibility('{"firefox": {"min": "128.0", "max": "140.*"}, "android": {}}'), { firefox: { min: '128.0', max: '140.*' }, android: {} });
    assert.deepEqual(parseCompatibility('{"firefox": {"min": "58.0a1", "max": "*"}}'), { firefox: { min: '58.0a1', max: '*' } });
  });

  const invalid: Array<[string, RegExp]> = [
    ['firefox', /is not valid JSON/],
    ['[]', /lists no application/],
    ['{}', /lists no application/],
    ['"firefox"', /must be a JSON array or object/],
    ['["firefox", "thunderbird"]', /names "thunderbird"; AMO knows firefox and android/],
    ['["firefox", "firefox"]', /names an application twice/],
    ['{"seamonkey": {}}', /names "seamonkey"/],
    ['{"firefox": "128.0"}', /compatibility\.firefox must be an object with min, max or both/],
    ['{"firefox": {"minimum": "128.0"}}', /has "minimum"; only min and max are allowed/],
    ['{"firefox": {"min": "*"}}', /compatibility\.firefox\.min must be a version string/],
    ['{"firefox": {"min": 128}}', /compatibility\.firefox\.min must be a version string/],
    ['{"android": {"max": "latest"}}', /compatibility\.android\.max must be a version string/],
  ];
  for (const [input, pattern] of invalid) {
    it(`refuses ${input}`, () => fails(input, pattern));
  }
});

describe('compatibilityMatches', () => {
  const current = { firefox: { min: '128.0', max: '*' }, android: { min: '142.0', max: '*' } };

  it('compares the application set for an array', () => {
    assert.equal(compatibilityMatches(['android', 'firefox'], current), true);
    assert.equal(compatibilityMatches(['firefox'], current), false);
    assert.equal(compatibilityMatches(['firefox', 'android'], { firefox: current.firefox }), false);
  });

  it('compares only the bounds an object gives', () => {
    assert.equal(compatibilityMatches({ firefox: { min: '128.0' }, android: {} }, current), true);
    assert.equal(compatibilityMatches({ firefox: { min: '128.0', max: '140.*' }, android: {} }, current), false);
    assert.equal(compatibilityMatches({ firefox: { min: '128.0' } }, current), false);
  });
});

describe('describeCompatibility', () => {
  it('names each application and its bounds', () => {
    assert.equal(describeCompatibility(['firefox', 'android']), 'firefox and android');
    assert.equal(describeCompatibility({ firefox: { min: '128.0', max: '*' }, android: {} }), 'firefox 128.0 to *, android');
    assert.equal(describeCompatibility({ firefox: { min: '128.0' }, android: { max: '140.*' } }), 'firefox from 128.0, android up to 140.*');
    assert.equal(describeCompatibility({}), 'no application');
  });
});
