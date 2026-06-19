import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

test('idempotency returns same resource for same key', async () => {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9091' } });
  const base = 'http://localhost:9091';

  // Wait for server to be ready
  for (let i = 0; i < 20; i++) {
    try {
      await new Promise((res, rej) => {
        const req = http.get(`${base}/healthz`, (r) => {
          if (r.statusCode === 200) res();
          else rej();
        });
        req.on('error', rej);
        req.end();
      });
      break;
    } catch {
      await wait(100);
    }
  }

  const idem = 'same-key';

  const a = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });
  const b = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
    body: { userId: 'u1', type: 'note', payload: 'x' }
  });

  assert.equal(a.id, b.id);
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  proc.kill();
});

async function postJson(url, { headers, body }){
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let chunks=''; res.on('data', d => chunks+=d);
      res.on('end', () => resolve(JSON.parse(chunks||'{}')));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}
