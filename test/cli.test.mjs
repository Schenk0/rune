import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';

async function run(args, handler) {
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, ['dist/cli.js', ...args], {
    env: { ...process.env, RUNE_TOKEN: 'local-test', RUNE_API_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const [code] = await once(child, 'close');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  return { code, stdout, stderr, requests };
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
