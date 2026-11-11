import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestOptions } from '@aiostreams/core';
import { Response } from 'undici';
import {
  convertDeepbridSubtitle,
  type DeepbridSubtitleConversionDependencies,
  type Requester,
} from './deepbrid-subtitle-conversion.js';

function requestQueue(
  responses: Response[],
  calls: { url: string; init: Record<string, any> }[] = []
): Requester {
  return (async (url: string, init: RequestOptions) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected test request');
    return response;
  }) as Requester;
}

function dependencies(
  request: Requester
): DeepbridSubtitleConversionDependencies {
  return {
    request,
    isUnsafeRemoteUrl: (url: string) => /127\.0\.0\.1|localhost/i.test(url),
    readBodyCapped: async (response: Response, maxBytes: number) => {
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > maxBytes) throw new Error('exceeds byte limit');
      return body;
    },
    playerBase: 'https://player.example.invalid',
    userAgent: 'OrbisCast test agent',
  };
}

test('Deepbrid player conversion fetches source, authenticates only converter, and returns VTT', async () => {
  const calls: { url: string; init: Record<string, any> }[] = [];
  const request = requestQueue(
    [
      new Response('[Script Info]\nTitle: test'),
      new Response(
        JSON.stringify({ vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi' })
      ),
    ],
    calls
  );

  const vtt = await convertDeepbridSubtitle(
    'test-key',
    'https://subs.example/captions.ass',
    dependencies(request)
  );

  assert.match(vtt, /^WEBVTT/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.headers.Authorization, undefined);
  assert.equal(calls[1]!.init.method, 'POST');
  assert.equal(
    calls[1]!.init.headers.Authorization,
    'Bearer test-key'
  );
  assert.equal(calls[1]!.init.body, '[Script Info]\nTitle: test');
  assert.equal(new URL(calls[1]!.url).pathname, '/web/sub/convert');
  assert.equal(
    calls.every(({ url }) => !url.includes('test-key')),
    true
  );
});

test('subtitle source redirects are revalidated and cannot target private hosts', async () => {
  const calls: { url: string; init: Record<string, any> }[] = [];
  const request = requestQueue(
    [
      new Response(null, {
        status: 302,
        headers: { Location: 'https://127.0.0.1/private.ass' },
      }),
    ],
    calls
  );

  await assert.rejects(
    convertDeepbridSubtitle(
      'private-deepbrid-key',
      'https://subs.example/captions.ass',
      dependencies(request)
    ),
    /Unsafe subtitle source URL/
  );
  assert.equal(calls.length, 1);
});

test('subtitle and converter response bodies are bounded', async () => {
  const tooLarge = new Response(new Uint8Array(5 * 1024 * 1024 + 1));
  const request = requestQueue([tooLarge]);
  await assert.rejects(
    convertDeepbridSubtitle(
      'private-deepbrid-key',
      'https://subs.example/captions.ass',
      dependencies(request)
    ),
    /byte limit/
  );
});

test('converter redirects and malformed non-WebVTT responses fail closed', async () => {
  const redirectRequest = requestQueue([
    new Response('subtitle'),
    new Response(null, {
      status: 302,
      headers: { Location: 'https://elsewhere.example/collect' },
    }),
  ]);
  await assert.rejects(
    convertDeepbridSubtitle(
      'private-deepbrid-key',
      'https://subs.example/captions.ass',
      dependencies(redirectRequest)
    ),
    /redirect was rejected/
  );

  const malformedRequest = requestQueue([
    new Response('subtitle'),
    new Response(JSON.stringify({ vtt: 'not a VTT file' })),
  ]);
  await assert.rejects(
    convertDeepbridSubtitle(
      'private-deepbrid-key',
      'https://subs.example/captions.ass',
      dependencies(malformedRequest)
    ),
    /invalid WebVTT response/
  );
});
