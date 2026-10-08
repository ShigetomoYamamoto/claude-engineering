// gate-html local receiver.
//   node receiver.mjs url   --doc-id <id> --token <hex32> --file <name.html>
//   node receiver.mjs serve --root <dir> --file <name.html> --doc-id <id> --token <hex32> [--once] [--port <n>]
// stdout carries protocol lines only (READY / SUBMIT / ERROR). Diagnostics go to stderr.
// Never writes files, never sends CORS headers, binds 127.0.0.1 only.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BODY = 256 * 1024;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.html$/;
const DOC_ID_RE = /^[a-z0-9-]{3,64}$/;
const KIND = 'gate-html/requirements';

// Stable per-document port so the page origin (and its localStorage autosave)
// survives a receiver restart. Shared by `url` and `serve`.
function derivePort(docId) {
  const h = crypto.createHash('sha256').update(docId).digest();
  return 49152 + (h.readUInt32BE(0) % 16384);
}

function parseArgs(argv) {
  const flags = new Set();
  const vals = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--once') { flags.add('once'); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) die(2, `missing value for ${a}`);
    vals[a.slice(2)] = next;
    i++;
  }
  return { flags, vals };
}

function die(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function validateCommon(vals) {
  if (!vals['doc-id'] || !DOC_ID_RE.test(vals['doc-id'])) die(2, 'invalid or missing --doc-id');
  if (!vals.token || !TOKEN_RE.test(vals.token)) die(2, 'invalid or missing --token (expected 32 lowercase hex chars)');
  if (!vals.file || !FILE_RE.test(vals.file)) die(2, 'invalid or missing --file (expected NAME.html)');
}

function resolvePort(vals) {
  if (vals.port === undefined) return derivePort(vals['doc-id']);
  const n = Number(vals.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) die(2, 'invalid --port');
  return n;
}

function runUrl(vals) {
  validateCommon(vals);
  const port = resolvePort(vals);
  process.stdout.write(`URL http://127.0.0.1:${port}/${vals.token}/${vals.file}\n`);
}

function runServe(flags, vals) {
  validateCommon(vals);
  if (!vals.root) die(2, 'missing --root');
  const root = path.resolve(vals.root);
  const port = resolvePort(vals);
  const { token, file, 'doc-id': docId } = vals;
  try {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error('not a regular file');
  } catch {
    die(2, `--file ${file} not found as a regular file under --root`);
  }
  const once = flags.has('once');
  const self = `127.0.0.1:${port}`;
  let submitted = false; // --once latch: only the first valid submit may produce a SUBMIT line

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  };
  const plain = (res, status, msg) => send(res, status, msg, { 'Content-Type': 'text/plain; charset=utf-8' });
  const notFound = (res) => plain(res, 404, 'Not Found');

  const server = http.createServer((req, res) => {
    if (req.headers.host !== self) return plain(res, 403, 'Forbidden');
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${self}`) {
      return plain(res, 403, 'Forbidden');
    }

    const parts = (req.url || '').split('?')[0].split('/'); // ['', token, name]
    if (parts.length !== 3 || parts[0] !== '' || parts[1] !== token) return notFound(res);
    const name = parts[2];

    if (req.method === 'GET' && name === file) {
      fs.readFile(path.join(root, file), (err, data) => {
        if (err) return notFound(res);
        send(res, 200, data, { 'Content-Type': 'text/html; charset=utf-8' });
      });
      return;
    }

    if (req.method === 'POST' && name === 'submit') {
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', (c) => {
        if (rejected) return;
        size += c.length;
        if (size > MAX_BODY) {
          rejected = true;
          chunks.length = 0;
          res.writeHead(413, { Connection: 'close', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end('Payload Too Large');
          // Drain/ignore the rest of the body; drop the socket only after the 413 is flushed.
          req.resume();
          res.on('finish', () => req.socket.destroy());
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (rejected) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return plain(res, 400, 'Bad Request');
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body) || body.kind !== KIND || body.docId !== docId) {
          return plain(res, 400, 'Bad Request');
        }
        if (once) {
          if (submitted) return plain(res, 409, 'Conflict');
          submitted = true; // set synchronously, before the SUBMIT line is written
          // 'close' fires on normal finish and on client abort, so --once always exits.
          if (res.destroyed) setImmediate(shutdown); else res.on('close', () => shutdown());
        }
        process.stdout.write('SUBMIT ' + JSON.stringify(body) + '\n', () => {
          send(res, 200, '{"ok":true}', { 'Content-Type': 'application/json; charset=utf-8' });
        });
      });
      req.on('error', () => {});
      return;
    }

    return notFound(res);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stdout.write(`ERROR port-busy ${port}\n`, () => process.exit(3));
      return;
    }
    process.stderr.write('server error: ' + e.message + '\n');
    process.stdout.write(`ERROR server ${e.code || 'unknown'}\n`, () => process.exit(1));
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`READY http://127.0.0.1:${port}/${token}/${file}\n`);
  });
}

const { flags, vals } = parseArgs(process.argv.slice(3));
const sub = process.argv[2];
if (sub === 'url') runUrl(vals);
else if (sub === 'serve') runServe(flags, vals);
else die(2, 'usage: receiver.mjs url|serve [options]');
