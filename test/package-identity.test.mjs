import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('npm package, lockfile, and documented installation use the matuto-ai scope', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, '@matuto-ai/pi-broker-connector');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.repository.url, 'git+https://github.com/matuto-ai/pi-broker-connector.git');
  const docs = read('README.md');
  assert.ok(docs.includes(`pi install npm:${pkg.name}@${pkg.version}`));
  assert.ok(!docs.includes('@brunoorsolon/'));
});
