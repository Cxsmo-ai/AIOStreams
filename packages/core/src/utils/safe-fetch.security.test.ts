import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  fetchRemoteCapped,
  readBodyCapped,
  readBodyUpTo,
} from './safe-fetch.js';

const options = {
  maxBytes: 1024,
  timeoutMs: 1000,
  allowPrivateHosts: true,
};

test('private-host opt-out never allows a non-HTTP scheme', async () => {
  await assert.rejects(
    fetchRemoteCapped('data:text/plain,should-not-be-read', options),
    /unsafe scheme/
  );
});

test('body readers reject invalid byte limits before reading', async () => {
  const response = new Response('payload');
  await assert.rejects(readBodyUpTo(response, -1), RangeError);
  await assert.rejects(
    readBodyUpTo(response, Number.POSITIVE_INFINITY),
    RangeError
  );
  await assert.rejects(readBodyCapped(new Response('payload'), -1), RangeError);
});

test('remote fetch rejects invalid resource limits before making a request', async () => {
  await assert.rejects(
    fetchRemoteCapped('https://example.com', { ...options, maxBytes: -1 }),
    RangeError
  );
  await assert.rejects(
    fetchRemoteCapped('https://example.com', { ...options, timeoutMs: 0 }),
    RangeError
  );
  await assert.rejects(
    fetchRemoteCapped('https://example.com', { ...options, timeoutMs: 0.5 }),
    RangeError
  );
  await assert.rejects(
    fetchRemoteCapped('https://example.com', {
      ...options,
      timeoutMs: 0x1_0000_0000,
    }),
    RangeError
  );
  await assert.rejects(
    fetchRemoteCapped('https://example.com', { ...options, maxRedirects: -1 }),
    RangeError
  );
});

test('one timeout bounds the complete redirect chain', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/first') {
      setTimeout(() => {
        res.writeHead(302, { location: '/second' }).end();
      }, 30);
      return;
    }
    setTimeout(() => res.end('late'), 30);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await assert.rejects(
      fetchRemoteCapped(`http://127.0.0.1:${address.port}/first`, {
        ...options,
        timeoutMs: 45,
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
