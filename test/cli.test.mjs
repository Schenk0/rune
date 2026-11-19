import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function run(args, handler) {
  const requests = [];
  const exchanges = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const exchange = { method: req.method, url: req.url, headers: req.headers, body: '' };
    exchanges.push(exchange);
    req.on('data', value => exchange.body += value);
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, ['dist/cli.js', ...args], {
    env: {
      ...process.env, RUNE_TOKEN: 'local-test', RUNE_API_URL: `http://127.0.0.1:${server.address().port}`,
      RUNE_PUBLIC_ORIGIN: 'http://localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const [code] = await once(child, 'close');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  return { code, stdout, stderr, requests, exchanges };
}

async function fixture(t, content, filename = 'report.html') {
  const directory = await mkdtemp(join(tmpdir(), 'rune-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, filename);
  await writeFile(path, content);
  return path;
}

const publicationUrl = 'http://abcdefghijkl.localhost/';

function acceptUpload(req, res, id = 'abcdefghijkl') {
  if (req.method === 'HEAD') {
    res.writeHead(200, { etag: '"current-revision"' });
    res.end();
    return;
  }
  req.resume();
  req.on('end', () => {
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, url: `http://${id}.localhost/`, etag: '"next-revision"' }));
  });
}

test('foreign URLs cannot trigger destructive requests', async () => {
  const r = await run(['delete', 'https://abcdefghijkl.unrelated.example/'], (_, res) => { res.writeHead(204); res.end(); });
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.requests, []);
});

test('explicit IDs remain valid', async () => {
  const r = await run(['delete', 'abcdefghijkl'], (_, res) => { res.writeHead(204); res.end(); });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.requests, ['/uploads/abcdefghijkl']);
});

test('invalid success responses do not print a publication URL', async () => {
  const r = await run(['publish', 'package.json'], (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"url":"https://wrong.example/"}'); });
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
});

test('HTML publish remembers only the URL locally without a second upload', async t => {
  const original = '<!doctype html>\n<HTML><HEAD><title>Report</title>'
    + '<!-- <meta name="rune-url" content="https://comment.example/"> -->'
    + '<script>const example = \'<meta name="rune-url" content="https://script.example/">\';</script>'
    + '</HEAD><BODY>Report</BODY></HTML>';
  const path = await fixture(t, original);
  const r = await run(['publish', path, '--json'], acceptUpload);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).url, publicationUrl);
  assert.equal(r.exchanges.length, 1);
  assert.equal(r.exchanges[0].method, 'POST');
  assert.equal(r.exchanges[0].body, original);
  assert.equal(await readFile(path, 'utf8'), original.replace('</HEAD>', `<meta name="rune-url" content="${publicationUrl}"></HEAD>`));
  assert.deepEqual(await readdir(join(path, '..')), ['report.html']);
});

test('inferred replacement fetches the current ETag and leaves a correct tag untouched', async t => {
  const original = `<html><head><meta CONTENT='${publicationUrl}' NAME='rune-url'></head><body>Updated</body></html>`;
  const path = await fixture(t, original);
  const before = await stat(path);
  const r = await run(['replace', path], acceptUpload);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), publicationUrl);
  assert.deepEqual(r.exchanges.map(req => req.method), ['HEAD', 'PUT']);
  assert.equal(r.exchanges[1].url, '/uploads/abcdefghijkl?filename=report.html');
  assert.equal(r.exchanges[1].headers['if-match'], '"current-revision"');
  assert.equal(r.exchanges[1].body, original);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

test('publish creates a new link for copied HTML and updates its local tag', async t => {
  const oldTag = `<meta name="rune-url" content="${publicationUrl}">`;
  const original = `<html><head>${oldTag}</head><body>Copy</body></html>`;
  const path = await fixture(t, original);
  const r = await run(['publish', path], (req, res) => acceptUpload(req, res, 'mnopqrstuvwx'));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.exchanges.map(req => req.method), ['POST']);
  assert.equal(r.stdout.trim(), 'http://mnopqrstuvwx.localhost/');
  assert.equal(await readFile(path, 'utf8'), original.replace(oldTag, '<meta name="rune-url" content="http://mnopqrstuvwx.localhost/">'));
});

test('explicit replacement associates HTML with the chosen target and consolidates duplicate tags', async t => {
  const original = `<html><head><meta name="rune-url" content="${publicationUrl}">`
    + `<meta name="rune-url" content="${publicationUrl}"></head><body>Report</body></html>`;
  const path = await fixture(t, original);
  const r = await run(['replace', 'mnopqrstuvwx', path], (req, res) => acceptUpload(req, res, 'mnopqrstuvwx'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.exchanges[1].url, '/uploads/mnopqrstuvwx?filename=report.html');
  assert.equal(await readFile(path, 'utf8'), '<html><head><meta name="rune-url" content="http://mnopqrstuvwx.localhost/"></head><body>Report</body></html>');
});

test('HTML with an omitted head or a fragment gets a readable publication tag', async t => {
  for (const original of ['<!doctype html><html><body>Report</body></html>', '<!doctype html><title>Report</title><p>Body', '<p>Body']) {
    const path = await fixture(t, original, 'report.HTM');
    const published = await run(['publish', path], acceptUpload);
    assert.equal(published.code, 0, published.stderr);
    const updated = await readFile(path, 'utf8');
    assert.equal(updated.replace(`<meta name="rune-url" content="${publicationUrl}">`, ''), original);
    if (original.startsWith('<!doctype')) assert.ok(updated.startsWith('<!doctype html>'));
    const replaced = await run(['replace', path], acceptUpload);
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.equal(replaced.exchanges[1].url, '/uploads/abcdefghijkl?filename=report.HTM');
  }
});

test('missing, ambiguous, and foreign publication tags fail before any API request', async t => {
  const valid = `<meta name="rune-url" content="${publicationUrl}">`;
  for (const content of [
    '<!-- ' + valid + ' --><script>const tag = \'<meta name="rune-url" content="http://abcdefghijkl.localhost/">\';</script>',
    '<template>' + valid + '</template>',
    '<html><head>' + valid + valid + '</head></html>',
    '<html><head><meta name="rune-url" content="https://abcdefghijkl.unrelated.example/"></head></html>',
    '<html><head><meta name="rune-url" content="http://abcdefghijkl.localhost/?query=1"></head></html>',
  ]) {
    const path = await fixture(t, content);
    const r = await run(['replace', path], acceptUpload);
    assert.notEqual(r.code, 0);
    assert.deepEqual(r.requests, []);
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

test('failed uploads leave local HTML unchanged', async t => {
  const original = '<html><head></head><body>Report</body></html>';
  const path = await fixture(t, original);
  const r = await run(['publish', path], (req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(503); res.end('Try later'); });
  });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('a local annotation failure still reports upload success', async t => {
  const path = await fixture(t, '<html><head></head><body>Report</body></html>');
  const r = await run(['publish', path], (req, res) => {
    req.resume();
    req.on('end', async () => {
      await rm(path);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'abcdefghijkl', url: publicationUrl, etag: '"next-revision"' }));
    });
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), publicationUrl);
  assert.match(r.stderr, /Upload succeeded, but could not save rune-url/);
  assert.equal(r.exchanges.length, 1);
});

test('non-HTML uploads stay unchanged and require an explicit replacement target', async t => {
  const original = '# Report\n';
  const path = await fixture(t, original, 'report.md');
  const published = await run(['publish', path], acceptUpload);
  assert.equal(published.code, 0, published.stderr);
  assert.equal(await readFile(path, 'utf8'), original);
  const inferred = await run(['replace', path], acceptUpload);
  assert.notEqual(inferred.code, 0);
  assert.deepEqual(inferred.requests, []);
  const explicit = await run(['replace', publicationUrl, path], acceptUpload);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(await readFile(path, 'utf8'), original);
});

const aliceToken = `rune_alice_${'a'.repeat(64)}`;
const alice = { id: 'alice', createdAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:00:00.000Z' };

test('provisioning writes a private credential file without printing the token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rune-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'alice-token');
  const result = await run(['users', 'create', 'alice', '--token-file', path], (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: alice, token: aliceToken }));
    });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(path, 'utf8'), `${aliceToken}\n`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(result.stdout.includes(aliceToken), false);
  assert.equal(result.stderr.includes(aliceToken), false);
  assert.equal(result.exchanges[0].body, JSON.stringify({ id: 'alice' }));
  assert.equal(result.exchanges[0].headers.authorization, 'Bearer local-test');
  const retry = await run(['users', 'create', 'alice', '--token-file', path], acceptUpload);
  assert.notEqual(retry.code, 0);
  assert.deepEqual(retry.requests, []);
  assert.equal(await readFile(path, 'utf8'), `${aliceToken}\n`);
});

test('failed or malformed provisioning removes the empty credential file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rune-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const status of [409, 201]) {
    const path = join(directory, `token-${status}`);
    const result = await run(['users', 'create', 'alice', '--token-file', path], (req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 409 ? { error: 'User already exists' } : { user: alice, token: 'invalid-token' }));
      });
    });
    assert.notEqual(result.code, 0);
    await assert.rejects(stat(path), { code: 'ENOENT' });
    assert.match(result.stderr, /rotate alice to recover/);
  }
});

test('rotation, revocation, and paginated listing use the management API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rune-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rotated = await run(['users', 'rotate', 'alice', '--token-file', join(directory, 'rotated')], (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ user: alice, token: aliceToken }));
    });
  });
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.equal(rotated.exchanges[0].url, '/users/alice/token');
  assert.equal(rotated.exchanges[0].method, 'POST');
  const revoked = await run(['users', 'revoke', 'alice'], (_, res) => { res.writeHead(204); res.end(); });
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.equal(revoked.exchanges[0].url, '/users/alice/token');
  assert.equal(revoked.exchanges[0].method, 'DELETE');
  const listed = await run(['users', 'list', '--json'], (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/users' ? { users: [alice], cursor: 'next' } : { users: [{ ...alice, id: 'bob' }] }));
  });
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(listed.requests, ['/users', '/users?cursor=next']);
  assert.deepEqual(JSON.parse(listed.stdout).map(user => user.id), ['alice', 'bob']);
});
