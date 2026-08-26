'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function loadTaxonomy() {
  return import('../hooks/scripts/lib/text-extensions.mjs');
}

test('taxonomy membership matches the moved sets plus the new data set', async () => {
  const {
    codeExtensions, isCodeExtension, isMarkdownExtension,
    markdownExtensions, suspectTextBasenames, textDataExtensions,
  } = await loadTaxonomy();
  for (const ext of ['.mjs', '.ts', '.py', '.sh', '.vue', '.sql']) {
    assert.equal(isCodeExtension(ext), true, ext);
  }
  for (const ext of ['.md', '.mdx', '.rst', '.adoc', '.org']) {
    assert.equal(isMarkdownExtension(ext), true, ext);
  }
  assert.equal(codeExtensions.includes('.mjs'), true);
  assert.equal(markdownExtensions.includes('.markdown'), true);
  for (const ext of ['.json', '.yml', '.csv', '.svg', '.astro']) {
    assert.equal(textDataExtensions.includes(ext), true, ext);
  }
  assert.equal(textDataExtensions.includes('.sql'), false, 'no cross-set duplicates');
  assert.equal(suspectTextBasenames.includes('Makefile'), true);
  const union = [...codeExtensions, ...markdownExtensions, ...textDataExtensions];
  assert.equal(new Set(union).size, union.length, 'sets are pairwise disjoint');
});

test('isSuspectTextPath: extensions, casing, basenames, separators', async () => {
  const { isSuspectTextPath } = await loadTaxonomy();
  assert.equal(isSuspectTextPath('src/control.mjs'), true);
  assert.equal(isSuspectTextPath('SRC\\CONTROL.MJS'), true);
  assert.equal(isSuspectTextPath('docs/readme.md'), true);
  assert.equal(isSuspectTextPath('conf/settings.yaml'), true);
  assert.equal(isSuspectTextPath('Makefile'), true);
  assert.equal(isSuspectTextPath('deep/dir/Dockerfile'), true);
  assert.equal(isSuspectTextPath('image.png'), false);
  assert.equal(isSuspectTextPath('blob.dat'), false);
  assert.equal(isSuspectTextPath('ghost'), false);
  assert.equal(isSuspectTextPath('.env'), false);
  assert.equal(isSuspectTextPath('conf/.env'), false);
  assert.equal(isSuspectTextPath('a.env'), false);
  assert.equal(isSuspectTextPath(''), false);
});

test('every exported taxonomy surface is mutation-resistant', async () => {
  const {
    codeExtensions, isSuspectTextPath, markdownExtensions,
    suspectTextBasenames, textDataExtensions,
  } = await loadTaxonomy();
  const surfaces = [codeExtensions, markdownExtensions, textDataExtensions, suspectTextBasenames];
  for (const surface of surfaces) {
    assert.equal(Object.isFrozen(surface), true);
    assert.throws(() => { surface.push('.evil'); }, TypeError);
  }
  assert.equal(isSuspectTextPath('x.evil'), false, 'membership unreachable from outside');
});
