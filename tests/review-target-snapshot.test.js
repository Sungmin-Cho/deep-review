const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = () => import('../hooks/scripts/lib/review-target-snapshot.mjs');
function fixture(t, git = true) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'target-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  if (git) {
    run('init', '-q');
    run('config', 'user.email', 'test@example.test');
    run('config', 'user.name', 'Test');
  }
  fs.writeFileSync(path.join(repo, 'a.js'), 'one\n');
  if (git) {
    run('add', '.');
    run('commit', '-qm', 'base');
  }
  return {
    repo,
    run,
    write: (p, v) => {
      fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
      fs.writeFileSync(path.join(repo, p), v);
    },
  };
}
test('staged snapshot sees index-only content change with identical worktree and status', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('a.js', 'two\n');
  f.run('add', 'a.js');
  f.write('a.js', 'worktree\n');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'staged',
    reviewBase: 'HEAD',
    records: [{ path: 'a.js', status: 'M' }],
  });
  assert.match(scope.review_base, /^[a-f0-9]{40}$/);
  const first = await captureReviewTarget({ scope });
  const status = f.run('status', '--porcelain');
  const blob = execFileSync('git', ['-C', f.repo, 'hash-object', '-w', '--stdin'], {
    input: 'three\n',
    encoding: 'utf8',
  }).trim();
  f.run('update-index', '--cacheinfo', `100644,${blob},a.js`);
  assert.equal(f.run('status', '--porcelain'), status);
  assert.equal(first.status, 'captured');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
});
test('runtime churn excluded but policy and explicit ignored document retained', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('.gitignore', '.deep-review/\ndocs/\n');
  f.run('add', '.gitignore');
  f.run('commit', '-qm', 'ignore');
  f.write('docs/spec.md', 'spec');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'mixed',
    reviewBase: 'HEAD',
    records: [{ path: 'docs/spec.md', status: 'session' }],
  });
  const first = await captureReviewTarget({ scope });
  f.write('.deep-review/reports/test-review.md', 'report');
  f.write('.deep-review/config.yaml', 'state');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), true);
  f.write('.deep-review/rules.yaml', 'policy');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
  f.write('docs/spec.md', 'changed');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
});
test('non-git explicit manifest detects edits/deletion and rejects unsafe/oversized paths', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t, false);
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'non-git',
    records: [{ path: 'a.js', status: 'non-git' }],
  });
  const first = await captureReviewTarget({ scope });
  fs.unlinkSync(path.join(f.repo, 'a.js'));
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
  fs.symlinkSync(os.tmpdir(), path.join(f.repo, 'escape'));
  for (const p of ['../escape', 'escape/out', 'bad\ud800'])
    await assert.rejects(
      createTargetScope({
        repo: f.repo,
        changeState: 'non-git',
        records: [{ path: p, status: 'non-git' }],
      }),
    );
  f.write('huge', Buffer.alloc(16 * 1024 * 1024 + 1));
  const huge = await createTargetScope({
    repo: f.repo,
    changeState: 'non-git',
    records: [{ path: 'huge', status: 'non-git' }],
  });
  assert.equal((await captureReviewTarget({ scope: huge })).status, 'indeterminate');
  assert.equal(sameReviewTarget({}, {}), false);
});
test('clean base is immutable, HEAD and scope narrowing change identity', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('b.js', 'second\n');
  f.run('add', '.');
  f.run('commit', '-qm', 'second');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'clean',
    reviewBase: 'HEAD~1',
    records: [
      { path: 'a.js', status: 'M' },
      { path: 'b.js', status: 'A' },
    ],
  });
  const first = await captureReviewTarget({ scope });
  assert.equal(first.status, 'captured');
  const narrowed = await createTargetScope({
    repo: f.repo,
    changeState: 'clean',
    reviewBase: scope.review_base,
    records: [{ path: 'a.js', status: 'M' }],
  });
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope: narrowed })), false);
  f.run('commit', '--allow-empty', '-qm', 'head only');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
  assert.equal(scope.review_base, f.run('rev-parse', 'HEAD~2'));
});
test('initial tracked index and untracked bytes; rename and missing deletion markers', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('new.js', 'new');
  f.run('mv', 'a.js', 'renamed.js');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'initial',
    records: [
      { path: 'renamed.js', old_path: 'a.js', status: 'R' },
      { path: 'new.js', status: '?' },
    ],
  });
  const first = await captureReviewTarget({ scope });
  assert.equal(first.status, 'captured');
  assert.equal(first.entries, 3);
  f.write('new.js', 'different');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
  fs.unlinkSync(path.join(f.repo, 'renamed.js'));
  assert.equal((await captureReviewTarget({ scope })).status, 'captured');
});
test('explicit runtime paths remain source and malformed UTF-8 git names fail capture', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('.deep-review/reports/source.md', 'selected');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'mixed',
    records: [{ path: '.deep-review/reports/source.md', status: 'session' }],
  });
  const first = await captureReviewTarget({ scope });
  f.write('.deep-review/reports/source.md', 'modified');
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
  if (process.platform !== 'win32') {
    const blob = f.run('rev-parse', 'HEAD:a.js');
    const invalid = Buffer.concat([Buffer.from(`100644 ${blob}\tbad`), Buffer.from([0xff, 0])]);
    execFileSync('git', ['-C', f.repo, 'update-index', '-z', '--index-info'], { input: invalid });
    assert.equal((await captureReviewTarget({ scope })).status, 'indeterminate');
  }
});
test('capture from filesFromZ includes binaries so host and classifier scopes match', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  f.run('add', '.');
  f.run('commit', '-qm', 'binary');
  const input = path.join(f.repo, '.deep-review/tmp/scope.json');
  fs.mkdirSync(path.dirname(input), { recursive: true });
  fs.writeFileSync(input, JSON.stringify({
    repo: f.repo,
    changeState: 'unstaged',
    reviewBase: f.run('rev-parse', 'HEAD'),
    filesFromZ: 'a.js\0icon.png\0',
  }));
  const captured = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, '..', 'hooks/scripts/review-evidence.mjs'),
    'capture', '--repo', f.repo, '--input', input,
  ], { encoding: 'utf8' }));
  assert.equal(captured.status, 'captured');
  assert.ok(captured.scope.files.some((row) => row.path === 'a.js'));
  assert.ok(captured.scope.files.some((row) => row.path === 'icon.png'));
});

test('non-selected dirty symlink is a guard and does not make capture indeterminate', async (t) => {
  const { createTargetScope, captureReviewTarget, sameReviewTarget } = await api();
  const f = fixture(t);
  f.write('target.txt', 'target\n');
  f.run('add', 'target.txt');
  f.run('commit', '-qm', 'target');
  fs.symlinkSync('target.txt', path.join(f.repo, 'link.txt'));
  f.write('a.js', 'two\n');
  const scope = await createTargetScope({
    repo: f.repo,
    changeState: 'unstaged',
    reviewBase: 'HEAD',
    records: [{ path: 'a.js', status: 'M' }],
  });
  const first = await captureReviewTarget({ scope });
  assert.equal(first.status, 'captured');
  fs.unlinkSync(path.join(f.repo, 'link.txt'));
  assert.equal(sameReviewTarget(first, await captureReviewTarget({ scope })), false);
});
