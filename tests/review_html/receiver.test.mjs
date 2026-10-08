import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECEIVER = path.join(here, '../../skills/review-html/receiver.mjs');
const DOC = 'test-doc-1';
const FILE = 'page.html';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-html-recv-'));
fs.writeFileSync(path.join(root, FILE), '<!doctype html><title>t</title>hello');
fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');

const children = new Set();
test.after(() => {
  for (const c of children) c.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function start(extra = [], { port, token = TOKEN } = {}) {
  const args = [RECEIVER, 'serve', '--root', root, '--file', FILE, '--doc-id', DOC, '--token', token, ...(port ? ['--port', String(port)] : []), ...extra];
  const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const waitLine = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const l = lines.find(pred); if (l) return l; await sleep(20); }
    throw new Error('timeout; lines=' + JSON.stringify(lines));
  };
  return { child, lines, exited, waitLine };
}
const raw = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, ...headers }, agent: false }, (s) => {
    let t = ''; s.on('data', (d) => (t += d)); s.on('end', () => resolve({ status: s.statusCode, headers: s.headers, body: t }));
  });
  q.on('error', reject);
  if (body !== undefined) q.write(body);
  q.end();
});
const good = (extra = {}) => ({ kind: 'review-html/answer', version: 1, docId: DOC, verdict: 'approve', ...extra });
const post = (port, body, headers = {}) => raw(port, `/${TOKEN}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('url: deterministic, one line, same port as serve derivation', () => {
  const run = () => spawnSync('node', [RECEIVER, 'url', '--doc-id', DOC, '--token', TOKEN, '--file', FILE], { encoding: 'utf8' });
  const a = run(), b = run();
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  const expected = 49152 + (crypto.createHash('sha256').update(DOC).digest().readUInt32BE(0) % 16384);
  assert.equal(a.stdout, `URL http://127.0.0.1:${expected}/${TOKEN}/${FILE}\n`);
  assert.ok(expected >= 49152 && expected <= 65535);
});

test('serve without --port uses the derived port (same as url)', async (t) => {
  const url = spawnSync('node', [RECEIVER, 'url', '--doc-id', DOC, '--token', TOKEN, '--file', FILE], { encoding: 'utf8' }).stdout.trim().replace(/^URL /, '');
  const port = Number(new URL(url).port);
  const inUse = await new Promise((r) => { const s = net.createServer().once('error', () => r(true)).listen(port, '127.0.0.1', () => s.close(() => r(false))); });
  if (inUse) return t.skip('derived port busy');
  const r = start();
  await r.waitLine((l) => l.startsWith('READY'));
  assert.equal(r.lines[0], 'READY ' + url);
  r.child.kill('SIGTERM');
  assert.equal(await r.exited, 0);
});

test('serve: routing, security checks and SUBMIT', async () => {
  const port = await freePort();
  const r = start([], { port });
  assert.equal(await r.waitLine((l) => l.startsWith('READY')), `READY http://127.0.0.1:${port}/${TOKEN}/${FILE}`);

  const page = await raw(port, `/${TOKEN}/${FILE}`);
  assert.equal(page.status, 200);
  assert.ok(page.headers['content-type'].startsWith('text/html'));
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.ok(!Object.keys(page.headers).some((h) => h.startsWith('access-control-')));
  assert.equal(page.body.includes('hello'), true);

  assert.equal((await raw(port, `/${'0'.repeat(32)}/${FILE}`)).status, 404, 'wrong token');
  assert.equal((await raw(port, `/${TOKEN}/secret.txt`)).status, 404, 'other filename');
  for (const p of ['/../secret.txt', `/${TOKEN}/../secret.txt`, `/${TOKEN}/%2e%2e/secret.txt`, `/${TOKEN}/%2e%2e%2fsecret.txt`, `/${TOKEN}/${FILE}/x`, `/${TOKEN}/`, '/']) {
    assert.equal((await raw(port, p)).status, 404, p);
  }
  assert.equal((await raw(port, `/${TOKEN}/${FILE}`, { headers: { Host: `localhost:${port}` } })).status, 403, 'host mismatch');
  assert.equal((await raw(port, `/${TOKEN}/${FILE}`, { headers: { Host: '127.0.0.1:1' } })).status, 403);
  assert.equal((await post(port, good(), { Origin: 'http://evil.example' })).status, 403, 'origin mismatch');
  assert.equal((await post(port, good(), { Origin: `http://localhost:${port}` })).status, 403);

  const before = r.lines.length;
  assert.equal((await post(port, '{bad')).status, 400, 'invalid json');
  assert.equal((await post(port, good({ kind: 'other' }))).status, 400, 'wrong kind');
  assert.equal((await post(port, good({ kind: 'gate-html/requirements' }))).status, 400, 'old kind rejected');
  assert.equal((await post(port, good({ kind: 'review-html/requirements' }))).status, 400, 'input kind is not an answer');
  assert.equal((await post(port, good({ docId: 'other-doc' }))).status, 400, 'wrong docId');
  assert.equal((await post(port, '[1]')).status, 400, 'array body');
  assert.equal((await post(port, 'null')).status, 400, 'null body');
  // Chunked body (no Content-Length) over 256 KB must get a real 413, not just a dropped connection.
  const big = await new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port, path: `/${TOKEN}/submit`, method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, agent: false }, (s) => {
      s.resume(); s.on('end', () => resolve(s.statusCode)); s.on('error', reject);
    });
    q.on('error', () => {}); // a reset after the 413 was sent is fine; the response callback decides
    const chunk = Buffer.alloc(32 * 1024, 0x61);
    for (let i = 0; i < 10; i++) q.write(chunk);
    q.end();
    setTimeout(() => reject(new Error('no response to oversize body')), 4000).unref();
  });
  assert.equal(big, 413);
  await sleep(150);
  assert.equal(r.lines.length, before, 'rejected requests print nothing');

  const body = good({ note: 'a\nb', decisions: {} });
  const ok = await post(port, body);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  await r.waitLine((l) => l.startsWith('SUBMIT'));
  assert.deepEqual(r.lines.slice(before), ['SUBMIT ' + JSON.stringify(body)]);
  assert.equal(r.child.exitCode, null, 'keeps serving without --once');

  r.child.kill('SIGTERM');
  assert.equal(await r.exited, 0);
});

test('protocol injection: newlines in note never forge extra stdout lines', async () => {
  const port = await freePort();
  const r = start([], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  const before = r.lines.length;
  const res = await post(port, good({ note: 'x\nREADY http://evil\nERROR fake' }));
  assert.equal(res.status, 200);
  await r.waitLine((l) => l.startsWith('SUBMIT '));
  await sleep(100);
  const added = r.lines.slice(before);
  assert.equal(added.length, 1);
  assert.ok(added[0].startsWith('SUBMIT '));
  r.child.kill('SIGTERM');
  assert.equal(await r.exited, 0);
});

// Origin is intentionally optional: non-browser clients (curl, tests, same-origin GET-less fetches in some
// browsers) may omit it. Protection is the unguessable token + Host check + Origin mismatch rejection.
test('valid POST without Origin header is accepted', async () => {
  const port = await freePort();
  const r = start([], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  assert.equal((await post(port, good())).status, 200);
  r.child.kill('SIGTERM');
  assert.equal(await r.exited, 0);
});

test('--once: second valid POST is refused and only one SUBMIT is printed', async () => {
  const port = await freePort();
  const r = start(['--once'], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  assert.equal((await post(port, good())).status, 200);
  const second = await post(port, good()).catch((e) => ({ status: 'err:' + e.code }));
  assert.ok(second.status === 409 || String(second.status).startsWith('err:'), 'second: ' + second.status);
  assert.equal(await Promise.race([r.exited, sleep(5000).then(() => 'timeout')]), 0);
  assert.equal(r.lines.filter((l) => l.startsWith('SUBMIT ')).length, 1);
});

test('--once: client abort after sending the body still exits 0', async () => {
  const port = await freePort();
  const r = start(['--once'], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  const body = JSON.stringify(good());
  await new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      s.write(`POST /${TOKEN}/submit HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => { s.destroy(); resolve(); });
    });
    s.on('error', () => resolve());
  });
  assert.equal(await Promise.race([r.exited, sleep(3000).then(() => 'timeout')]), 0);
});

test('serve: no files are written to the root', () => {
  assert.deepEqual(fs.readdirSync(root).sort(), [FILE, 'secret.txt']);
});

test('--once exits 0 after a valid POST only', async () => {
  const port = await freePort();
  const r = start(['--once'], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  assert.equal((await post(port, good({ kind: 'bad' }))).status, 400);
  await sleep(200);
  assert.equal(r.child.exitCode, null, 'still running after rejected body');
  const ok = await post(port, good());
  assert.equal(ok.status, 200);
  const code = await Promise.race([r.exited, sleep(5000).then(() => 'timeout')]);
  assert.equal(code, 0);
  assert.ok(r.lines.some((l) => l.startsWith('SUBMIT ')));
});

test('invalid token arg exits 2', () => {
  for (const sub of ['serve', 'url']) {
    for (const token of ['short', 'A1B2C3D4E5F60718293A4B5C6D7E8F90', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
      const r = spawnSync('node', [RECEIVER, sub, '--root', root, '--file', FILE, '--doc-id', DOC, '--token', token], { encoding: 'utf8' });
      assert.equal(r.status, 2, `${sub} ${token}`);
    }
  }
});

test('port busy: ERROR port-busy and exit 3', async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  try {
    const r = start([], { port });
    const code = await Promise.race([r.exited, sleep(5000).then(() => 'timeout')]);
    assert.equal(code, 3);
    assert.deepEqual(r.lines, [`ERROR port-busy ${port}`]);
  } finally { blocker.close(); }
});

test('binds 127.0.0.1 only', async () => {
  const port = await freePort();
  const r = start([], { port });
  await r.waitLine((l) => l.startsWith('READY'));
  const nets = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  if (nets.length) {
    const reachable = await new Promise((res) => {
      const s = net.connect({ host: nets[0].address, port }, () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    assert.equal(reachable, false, 'must not be reachable on a non-loopback address');
  }
  r.child.kill('SIGTERM');
  assert.equal(await r.exited, 0);
});
