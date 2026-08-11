import { createDecipheriv } from 'node:crypto';
import { inflateSync } from 'node:zlib';

function decryptConfigToken(token) {
  const padded = token + '='.repeat((4 - (token.length % 4)) % 4);
  const envelope = JSON.parse(
    Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8'
    )
  );
  if (!['a', 'aioEncrypt'].includes(envelope.t ?? envelope.type)) {
    throw new Error('Unexpected encrypted token format');
  }
  const keyHex = process.env.SECRET_KEY;
  if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new Error('SECRET_KEY is unavailable');
  }
  const decipher = createDecipheriv(
    'aes-256-cbc',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(envelope.i ?? envelope.iv, 'base64')
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.e ?? envelope.encrypted, 'base64')),
    decipher.final(),
  ]);
  return inflateSync(decrypted).toString('utf8');
}

const manifestUrl = process.env.PRIVATE_MANIFEST_URL;
if (!manifestUrl) throw new Error('PRIVATE_MANIFEST_URL is required');

const parts = new URL(manifestUrl).pathname.split('/').filter(Boolean);
const stremioIndex = parts.indexOf('stremio');
if (stremioIndex < 0 || parts.length < stremioIndex + 4) {
  throw new Error('The manifest URL does not contain a configuration identity');
}

const uuid = parts[stremioIndex + 1];
const encryptedPassword = parts[stremioIndex + 2];
const password = decryptConfigToken(encryptedPassword);

const authorization = `Basic ${Buffer.from(
  `${uuid}:${password}`,
  'utf8'
).toString('base64')}`;
const userResponse = await fetch('http://127.0.0.1:3000/api/v1/user?raw=true', {
  headers: { authorization },
});
if (!userResponse.ok) {
  throw new Error(`Could not load configuration (HTTP ${userResponse.status})`);
}
const userEnvelope = await userResponse.json();
const userData = userEnvelope?.data?.userData;
if (!userData) throw new Error('Configuration not found');

const presets = Array.isArray(userData.presets) ? userData.presets : [];
const matches = presets.filter(
  (preset) => preset?.type === 'newshosting-indexer'
);
if (matches.length === 0) throw new Error('No Newshosting preset was found');

let changed = 0;
for (const preset of matches) {
  preset.options ??= {};
  if (preset.options.resultPassthrough !== true) {
    preset.options.resultPassthrough = true;
    changed += 1;
  }
}

if (changed > 0) {
  const updateResponse = await fetch('http://127.0.0.1:3000/api/v1/user', {
    method: 'PUT',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ config: userData }),
  });
  if (!updateResponse.ok) {
    throw new Error(`Could not update configuration (HTTP ${updateResponse.status})`);
  }
}

console.log(JSON.stringify({ matchedPresets: matches.length, changed }));
