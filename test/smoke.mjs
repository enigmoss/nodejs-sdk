// Runtime smoke test of the built package (dist), without a test framework: `node test/smoke.mjs`, `bun test/smoke.mjs`.
// Checks a contract signature vector on the wire and a webhook vector.
import { readFileSync } from 'node:fs';
import { Enigmoss } from '../dist/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/contract/signature-vectors.json', import.meta.url), 'utf8'),
);
const { request, webhook } = vectors;
const get = request.vectors.find((v) => v.name === 'get-without-body');
const hook = webhook.vectors[0];

Date.now = () => Number(request.timestamp) * 1000;

let sent;
const enigmoss = new Enigmoss({
  baseUrl: 'https://api.example.com',
  projectId: request.project,
  paymentKey: request.secrets.payment,
  fetch: async (url, init) => {
    sent = { url, headers: init.headers };
    return new Response('{"data":{}}', { status: 200 });
  },
});
await enigmoss.project.get();
if (sent.url !== `https://api.example.com${get.path}` || sent.headers['X-Signature'] !== get.signature) {
  throw new Error(`request signature mismatch: ${JSON.stringify(sent)}`);
}

const receiver = new Enigmoss({ baseUrl: 'https://api.example.com', projectId: hook.project, paymentKey: hook.secret });
const event = await receiver.webhooks.verify(hook.body, {
  'X-Project-Uuid': hook.project,
  'X-Timestamp': hook.timestamp,
  'X-Signature': hook.signature,
});
if (event.event !== 'webhook.test') {
  throw new Error('webhook vector failed');
}
console.log('smoke ok');
