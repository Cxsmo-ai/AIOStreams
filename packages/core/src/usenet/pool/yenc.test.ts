import assert from 'node:assert/strict';
import test from 'node:test';
import yencode from 'yencode';
import { StreamingYencDecoder } from './yenc.js';

test('streaming yEnc decoder reuses scratch output across chunks', () => {
  const payload = Buffer.from(
    'AIOStreams native yEnc streaming should not allocate per socket chunk.'
  );
  const encoded = yencode.post('sample.mkv', payload, 32);
  const decoder = new StreamingYencDecoder();
  const outputs: Buffer[] = [];
  // StreamingYencDecoder intentionally consumes the data region after the
  // yEnc header; YencHeadCapture owns header stripping in production.
  const dataStart = encoded.indexOf(Buffer.from('\r\n')) + 2;
  const data = encoded.subarray(dataStart);

  for (let offset = 0; offset < data.length; offset += 11) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + 11));
    const decoded = decoder.push(chunk);
    if (decoded.length > 0) outputs.push(Buffer.from(decoded));
  }

  assert.deepEqual(Buffer.concat(outputs), payload);
  assert.equal(decoder.ended, true);
});
