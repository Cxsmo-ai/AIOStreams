import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  cleanTorboxNzbXml,
  chunkTorboxNzbHashes,
  fetchTorboxNzbDocument,
  fetchTorboxNzbHashes,
  getTorboxNzbHashes,
  normaliseTorboxDownloadUrl,
} from './torbox-nzb-hashes.js';

const md5 = (value: string | Buffer) =>
  createHash('md5').update(value).digest('hex');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <!-- ignored by the cleaned form -->
  <file poster="poster@example" date="1700000000" subject="Movie.1080p.mkv">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="10" number="1">first-file-part-1@example</segment>
      <segment bytes="10" number="2">first-file-part-2@example</segment>
    </segments>
  </file>
  <file poster="poster@example" date="1700000000" subject="Movie.en.srt">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="5" number="1">second-file-part-1@example</segment>
    </segments>
  </file>
</nzb>`;

test('generates exact URL, normalized URL, raw, cleaned, and first-message hashes', async () => {
  const url = 'HTTPS://Indexer.Example/download?id=123&apikey=secret#fragment';
  const hashes = await getTorboxNzbHashes({ url, xml });
  assert.ok(hashes.includes(md5(url)));
  assert.ok(hashes.includes(md5(normaliseTorboxDownloadUrl(url)!)));
  assert.ok(hashes.includes(md5(Buffer.from(xml))));
  const cleaned = cleanTorboxNzbXml(Buffer.from(xml));
  assert.match(cleaned.toString(), /^<\?xml version="1\.0" \?><nzb/);
  assert.doesNotMatch(cleaned.toString(), /<!--|poster=/);
  assert.ok(hashes.includes(md5(cleaned)));
  assert.ok(hashes.includes(md5('first-file-part-1@example')));
  assert.ok(hashes.includes(md5('second-file-part-1@example')));
  assert.ok(!hashes.includes(md5('first-file-part-2@example')));
  assert.equal(hashes.length, 6);
});

test('deduplicates and batches TorBox Usenet hashes at the documented limit', () => {
  const hashes = Array.from({ length: 205 }, (_, index) =>
    index.toString(16).padStart(32, '0')
  );
  const batches = chunkTorboxNzbHashes([...hashes, hashes[0].toUpperCase()]);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5]
  );
  assert.equal(new Set(batches.flat()).size, 205);
});

test('rejects internal DTDs, entities, malformed documents, and over-limit NZBs', async () => {
  await assert.rejects(
    getTorboxNzbHashes({
      xml: '<!DOCTYPE nzb [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><nzb>&xxe;</nzb>',
    }),
    /DTD\/entities/
  );
  await assert.rejects(getTorboxNzbHashes({ xml: '<nzb><file>' }));
  await assert.rejects(
    getTorboxNzbHashes({ xml }, { maxBytes: 10 }),
    /byte limit/
  );
  await assert.rejects(
    getTorboxNzbHashes({ xml }, { maxFiles: 1 }),
    /file limit/
  );
  await assert.rejects(
    getTorboxNzbHashes({ xml }, { maxSegments: 2 }),
    /segment limit/
  );
});

test('fetches once and returns the same validated bytes used for hashing', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(xml, {
      status: 200,
      headers: { 'content-length': String(Buffer.byteLength(xml)) },
    });
  }) as typeof fetch;
  const document = await fetchTorboxNzbDocument(
    'https://indexer.example/download?id=123',
    fetchImpl
  );
  assert.equal(calls, 1);
  assert.equal(document.xml.toString('utf8'), xml);
  assert.deepEqual(
    document.hashes,
    await getTorboxNzbHashes({
      url: 'https://indexer.example/download?id=123',
      xml,
    })
  );
});

test('refuses private-address NZB fetches before making a request', async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return new Response(xml);
  }) as typeof fetch;
  await assert.rejects(
    fetchTorboxNzbHashes('http://127.0.0.1/private.nzb', fetchImpl),
    /unsafe scheme or private address/
  );
  assert.equal(called, false);
});

test('rechecks every redirect hop against the private-address guard', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private.nzb' },
    });
  }) as typeof fetch;
  await assert.rejects(
    fetchTorboxNzbHashes('https://indexer.example/redirect.nzb', fetchImpl),
    /unsafe scheme or private address/
  );
  assert.equal(calls, 1);
});
