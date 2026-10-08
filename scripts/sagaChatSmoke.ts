import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Isolate from the machine's ~/.artemis: the vision profile is resolved from
// the home store first.
const home = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-chat-home-'));
process.env.ARTEMIS_HOME = home;

const { ProviderStore } = await import('../src/providers/store.js');
const {
  postSagaChatCompletion,
  rejectsCustomTemperature,
  resolveSagaChatEndpoint,
} = await import('../src/tools/visual/sagaChat.js');
const { analyzeNarrative } = await import('../src/tools/visual/sagaNarrative.js');

type Captured = { url: string; body: Record<string, unknown> };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withFetch<T>(
  handler: (request: Captured, index: number, init?: RequestInit) => Promise<Response> | Response,
  run: (requests: Captured[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const requests: Captured[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    requests.push(request);
    return handler(request, requests.length - 1, init);
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
}

const endpoint = { apiKey: 'smoke-key', baseUrl: 'https://llm.example.test/v1/' };
const okReply = { choices: [{ message: { content: '{"ok":true}' } }] };

// A model that rejects a custom temperature: the request is retried without it.
await withFetch(
  (request, index) => index === 0
    ? jsonResponse(400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } })
    : jsonResponse(200, okReply),
  async (requests) => {
    const res = await postSagaChatCompletion(endpoint, { model: 'gpt-6-sol', temperature: 0.2, max_tokens: 100, messages: [] });
    assert.equal(res.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(requests[0]!.body.temperature, 0.2);
    assert.equal('temperature' in requests[1]!.body, false, 'retry must drop the rejected temperature');
  },
);

// Known reasoning families never send a custom temperature.
assert.equal(rejectsCustomTemperature('gpt-5.5'), true);
assert.equal(rejectsCustomTemperature('openai/o3-mini'), true);
assert.equal(rejectsCustomTemperature('glm-4.6'), false);
await withFetch(
  () => jsonResponse(200, okReply),
  async (requests) => {
    const res = await postSagaChatCompletion(endpoint, { model: 'gpt-5.5', temperature: 0.2, messages: [] });
    assert.equal(res.ok, true);
    assert.equal(requests.length, 1);
    assert.equal('temperature' in requests[0]!.body, false);
  },
);

// max_tokens rejected in favour of max_completion_tokens.
await withFetch(
  (request, index) => index === 0
    ? jsonResponse(400, { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } })
    : jsonResponse(200, okReply),
  async (requests) => {
    const res = await postSagaChatCompletion(endpoint, { model: 'any-model', max_tokens: 600, messages: [] });
    assert.equal(res.ok, true);
    assert.equal(requests[1]!.body.max_completion_tokens, 600);
    assert.equal('max_tokens' in requests[1]!.body, false);
  },
);

// Other errors come back unchanged, without a retry.
await withFetch(
  () => jsonResponse(400, { error: { message: 'bad request: messages missing' } }),
  async (requests) => {
    const res = await postSagaChatCompletion(endpoint, { model: 'glm-4.6', temperature: 0.2, messages: [] });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.status, 400);
    assert.equal(requests.length, 1);
  },
);

// A hung relay times out instead of blocking.
await withFetch(
  (_request, _index, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }),
  async () => {
    // AbortSignal.timeout does not keep the process alive; a real socket would.
    const keepAlive = setInterval(() => {}, 1_000);
    const started = Date.now();
    const res = await postSagaChatCompletion(endpoint, { model: 'glm-4.6', messages: [] }, { timeoutMs: 50 });
    clearInterval(keepAlive);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.timedOut, true);
    assert.ok(Date.now() - started < 5_000);
  },
);

// Endpoint resolution: requests with images use the vision profile when the
// main model cannot see images; text-only requests stay on the main profile.
const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-chat-ws-'));
const store = new ProviderStore(cwd);
const data = await store.load();
data.profiles = [
  { id: 'main', protocol: 'openai', baseUrl: 'https://main.example.test/v1', apiKey: 'main-key', model: 'deepseek-chat', supportsImages: false },
  { id: 'vision', protocol: 'openai', baseUrl: 'https://vision.example.test/v1', apiKey: 'vision-key', model: 'qwen-vl-max', supportsImages: true },
];
data.defaultMainProfileId = 'main';
data.visionProfileId = 'vision';
await store.save(data);

const textEndpoint = await resolveSagaChatEndpoint(cwd);
assert.equal(textEndpoint?.source, 'main-profile');
assert.equal(textEndpoint?.model, 'deepseek-chat');
const imageEndpoint = await resolveSagaChatEndpoint(cwd, { needsImages: true });
assert.equal(imageEndpoint?.source, 'vision-profile');
assert.equal(imageEndpoint?.model, 'qwen-vl-max');
assert.equal(imageEndpoint?.baseUrl, 'https://vision.example.test/v1');

// Narrative analysis end to end: the temperature rejection no longer loses the analysis.
const analysis = {
  protagonist: { name: '方天豪', type: 'character', confidence: 0.9, evidence: 'named in the brief', aliases: [] },
  supportingCharacters: [],
  props: [],
  environments: ['码头'],
  relationships: [],
  actions: [],
  protagonistAccessories: [],
  mode: 'character',
};
await withFetch(
  (request, index) => index === 0
    ? jsonResponse(400, { error: { message: 'temperature is not supported for this model' } })
    : jsonResponse(200, { choices: [{ message: { content: JSON.stringify(analysis) } }] }),
  async (requests) => {
    const entities = await analyzeNarrative({ cwd, userText: '方天豪走过码头。' });
    assert.equal(entities?.protagonist.name, '方天豪');
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /main\.example\.test/);
  },
);

console.log('saga chat request smoke ok');
