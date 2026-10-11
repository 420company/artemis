#!/usr/bin/env tsx
/**
 * scripts/speechSmoke.ts — speech tools on a hosted VPS.
 *
 * transcribe_audio's platform backend (core/platformSpeech.ts): settings come
 * from the global providers.json only, each failure is worded plainly, long
 * recordings are split at pauses into pieces the platform takes (at most
 * five minutes, 12 MB), video files give their audio track, and the tool runs
 * end to end against a fake gateway (auth, model, WAV pieces, timestamps,
 * the saved transcript, a retry, a failure without local Whisper).
 *
 * synthesize_speech (core/edgeTts.ts): long text is split into pieces the
 * service takes, at sentence ends, losing nothing; the voice fits the text's
 * language (no English voice for Chinese text). The service itself is not
 * called here.
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/speechSmoke.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-speech-smoke-'));
process.env.ARTEMIS_HOME = path.join(tmpRoot, 'home');
process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = path.join(tmpRoot, 'media');
// No local Whisper in this test, whatever the machine has.
process.env.PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter((dir) => !['whisper', 'whisper-cli', 'main'].some((name) => fs.existsSync(path.join(dir, name))))
  .join(path.delimiter);
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true });

const { platformSpeechFromStore, transcribeWithPlatform, PlatformSpeechError, platformSpeechFallsBack } = await import('../src/core/platformSpeech.js');
const { planCuts, splitSpeechWav, wavHeader, parseWavHeader, formatTimestamp, SPEECH_SAMPLE_RATE } = await import('../src/core/audioChunks.js');
const { splitSpeechText, pickEdgeVoice, isMostlyChinese, EDGE_TTS_MAX_PIECE_BYTES } = await import('../src/core/edgeTts.js');
const { executeTranscribeAudio, transcribeFileWithPlatform } = await import('../src/tools/transcribeAudio.js');

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passes++;
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail !== undefined ? `\n       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

console.log('platform speech settings');
{
  const entry = { provider: 'platform', enabled: true, baseUrl: 'https://gw.example/v1', apiKey: 'ak-1', sttModel: 'asr-1', managedBy: 'platform' };
  assert('a complete entry is used', eq(platformSpeechFromStore({ speech: entry }), { baseUrl: 'https://gw.example/v1', apiKey: 'ak-1', sttModel: 'asr-1' }));
  assert(
    'off, another provider, no model, no key or a bad URL: none',
    platformSpeechFromStore({ speech: { ...entry, enabled: false } }) === undefined &&
      platformSpeechFromStore({ speech: { ...entry, provider: 'openai' } }) === undefined &&
      platformSpeechFromStore({ speech: { ...entry, sttModel: '' } }) === undefined &&
      platformSpeechFromStore({ speech: { ...entry, apiKey: undefined } }) === undefined &&
      platformSpeechFromStore({ speech: { ...entry, baseUrl: 'file:///etc' } }) === undefined &&
      platformSpeechFromStore({}) === undefined &&
      platformSpeechFromStore({ speech: [entry] }) === undefined,
  );
}

console.log('platform speech errors');
{
  const config = { baseUrl: 'https://gw.example/v1/', apiKey: 'ak-1', sttModel: 'asr-1' };
  const answer = (status: number, json: unknown, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } })) as unknown as typeof fetch;
  let seen: { url: string; headers: Record<string, string>; bytes: number } | undefined;
  const ok = (async (url: string, init: RequestInit) => {
    seen = { url, headers: init.headers as Record<string, string>, bytes: (init.body as Uint8Array).byteLength };
    return new Response(JSON.stringify({ text: ' 你好 ', durationSeconds: 3 }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await transcribeWithPlatform(new Uint8Array(10), 'audio/wav', config, { fetchImpl: ok, language: 'zh', prompt: '话题' });
  assert(
    'the request: endpoint, key, model, type, language, URI-encoded prompt',
    eq(result, { text: '你好', durationSeconds: 3 }) &&
      seen?.url === 'https://gw.example/v1/audio/transcriptions' &&
      seen.headers.authorization === 'Bearer ak-1' &&
      seen.headers['x-model'] === 'asr-1' &&
      seen.headers['content-type'] === 'audio/wav' &&
      seen.headers['x-language'] === 'zh' &&
      seen.headers['x-prompt'] === encodeURIComponent('话题') &&
      seen.bytes === 10,
    seen,
  );
  const codeOf = async (fetchImpl: typeof fetch) => {
    try {
      await transcribeWithPlatform(new Uint8Array(10), 'audio/wav', config, { fetchImpl });
      return 'resolved';
    } catch (error) {
      return error instanceof PlatformSpeechError ? `${error.code}|${error.message}` : `other|${String(error)}`;
    }
  };
  const cases: [number, string][] = [
    [402, 'insufficient_balance'],
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [413, 'too_large'],
    [415, 'unsupported_format'],
    [400, 'invalid_audio'],
    [404, 'unavailable'],
    [503, 'unavailable'],
    [500, 'failed'],
  ];
  const got: string[] = [];
  for (const [status, code] of cases) {
    const c = await codeOf(answer(status, { error: { code: 'x', message: 'detail' } }, status === 429 ? { 'retry-after': '5' } : {}));
    if (!c.startsWith(`${code}|`)) got.push(`${status}: ${c}`);
  }
  assert('each HTTP failure has its own code', got.length === 0, got);
  assert('a 429 says when to retry', (await codeOf(answer(429, {}, { 'retry-after': '5' }))).includes('retry in 5 s'));
  assert('a 200 without text is a failure, not an empty transcript', (await codeOf(answer(200, { durationSeconds: 1 }))).startsWith('failed|'));
  assert('unreachable', (await codeOf((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch)).startsWith('unreachable|'));
  assert(
    'oversize and empty recordings never leave the host',
    (await transcribeWithPlatform(new Uint8Array(12 * 1024 * 1024 + 1), 'audio/wav', config, { fetchImpl: ok }).catch((e) => e.code)) === 'too_large' &&
      (await transcribeWithPlatform(new Uint8Array(0), 'audio/wav', config, { fetchImpl: ok }).catch((e) => e.code)) === 'invalid_audio',
  );
  assert(
    'local Whisper is tried after an outage, never after a refusal of the recording or the balance',
    platformSpeechFallsBack(new PlatformSpeechError('unavailable', '')) &&
      platformSpeechFallsBack(new PlatformSpeechError('unreachable', '')) &&
      !platformSpeechFallsBack(new PlatformSpeechError('insufficient_balance', '')) &&
      !platformSpeechFallsBack(new PlatformSpeechError('invalid_audio', '')),
  );
}

console.log('splitting long audio');
{
  // 10 frames per second; quiet at frames 2700 and 5600.
  const levels = new Float32Array(9000).fill(1000);
  levels[2700] = 3;
  levels[5600] = 1;
  const cuts = planCuts(levels, 3000, 450);
  assert('cuts land in the pauses, every piece within the limit', eq(cuts, [2700, 5600, 8600]), cuts);
  const flat = planCuts(new Float32Array(7000).fill(5), 3000, 450);
  assert('without pauses, pieces are as long as allowed', eq(flat, [3000, 6000]), flat);
  assert('a short recording is one piece', planCuts(new Float32Array(3000), 3000, 450).length === 0);
  assert('timestamps', formatTimestamp(65) === '1:05' && formatTimestamp(3725) === '1:02:05' && formatTimestamp(0) === '0:00');

  // A real WAV: 11 minutes of tone with 1.5 s gaps at 4:30 and 9:10.
  const seconds = 660;
  const pcm = Buffer.alloc(seconds * SPEECH_SAMPLE_RATE * 2);
  for (let i = 0; i < seconds * SPEECH_SAMPLE_RATE; i++) {
    const t = i / SPEECH_SAMPLE_RATE;
    const gap = (t >= 270 && t < 271.5) || (t >= 550 && t < 551.5);
    pcm.writeInt16LE(gap ? 0 : Math.round(Math.sin(t * 2 * Math.PI * 220) * 8000), i * 2);
  }
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'wav-'));
  const wav = path.join(dir, 'long.wav');
  fs.writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  const { pieces, durationSeconds } = await splitSpeechWav(wav, dir);
  const starts = pieces.map((p) => Math.round(p.startSeconds));
  const sizes = pieces.map((p) => fs.statSync(p.path).size);
  assert(
    'an 11-minute WAV becomes three pieces cut in its pauses, each a valid WAV under 12 MB',
    pieces.length === 3 &&
      Math.round(durationSeconds) === 660 &&
      Math.abs(starts[1]! - 270) <= 2 &&
      Math.abs(starts[2]! - 550) <= 2 &&
      sizes.every((s) => s < 12 * 1024 * 1024) &&
      pieces.every((p) => p.durationSeconds <= 300) &&
      Math.round(pieces.reduce((t, p) => t + p.durationSeconds, 0)) === 660 &&
      pieces.every((p) => parseWavHeader(fs.readFileSync(p.path).subarray(0, 64), fs.statSync(p.path).size).dataBytes === fs.statSync(p.path).size - 44),
    { starts, sizes },
  );
}

console.log('speech text and voices');
{
  const zh = '这是第一句话。这是第二句话！还有第三句？'.repeat(80);
  const pieces = splitSpeechText(zh);
  assert(
    'long Chinese text: pieces within the limit, at sentence ends, nothing lost',
    pieces.length > 1 &&
      pieces.every((p) => Buffer.byteLength(p) <= EDGE_TTS_MAX_PIECE_BYTES) &&
      pieces.every((p) => /[。！？]$/.test(p)) &&
      pieces.join('') === zh,
    pieces.map((p) => Buffer.byteLength(p)),
  );
  const en = 'Version 3.14 is out. It fixes things & more! '.repeat(120);
  const enPieces = splitSpeechText(en);
  assert(
    'long English text: decimals stay whole, escaped size within the limit',
    enPieces.length > 1 &&
      enPieces.every((p) => Buffer.byteLength(p.replace(/&/g, '&amp;')) <= EDGE_TTS_MAX_PIECE_BYTES) &&
      enPieces.join(' ').replace(/\s+/g, ' ') === en.trim().replace(/\s+/g, ' ') &&
      !enPieces.some((p) => p.endsWith('3.')),
  );
  const run = '很'.repeat(3000);
  assert('one endless sentence is still split', splitSpeechText(run).every((p) => Buffer.byteLength(p) <= EDGE_TTS_MAX_PIECE_BYTES) && splitSpeechText(run).join('') === run);
  assert('empty text: no pieces', splitSpeechText('  \n ').length === 0);
  assert(
    'voices: asked > configured if it fits > a default for the language',
    pickEdgeVoice('你好，世界', { voice: 'zh-CN-YunxiNeural' }) === 'zh-CN-YunxiNeural' &&
      pickEdgeVoice('你好，世界', { configured: 'en-US-AriaNeural' }) === 'zh-CN-XiaoxiaoNeural' &&
      pickEdgeVoice('Hello there', { configured: 'en-US-GuyNeural' }) === 'en-US-GuyNeural' &&
      pickEdgeVoice('Hello there', { configured: 'zh-CN-YunxiNeural' }) === 'en-US-AriaNeural' &&
      pickEdgeVoice('你好', { configured: 'en-US-AvaMultilingualNeural' }) === 'en-US-AvaMultilingualNeural' &&
      pickEdgeVoice('Hello', { language: 'zh-CN' }) === 'zh-CN-XiaoxiaoNeural',
  );
  assert('mixed text with Chinese is Chinese', isMostlyChinese('用 NFT 质押') && !isMostlyChinese('Use the NFT staking page 页'));
}

console.log('transcribe_audio against a fake gateway');
{
  const calls: { model?: string; type?: string; auth?: string; bytes: number }[] = [];
  let failNext = 0;
  let outage = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url !== '/v1/audio/transcriptions' || req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer ak-test') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'unauthorized' } }));
        return;
      }
      if (outage) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'upstream_unavailable' } }));
        return;
      }
      if (failNext > 0) {
        failNext--;
        res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'upstream_error' } }));
        return;
      }
      if (body.length > 12 * 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      calls.push({ model: req.headers['x-model'] as string, type: req.headers['content-type'], auth: req.headers.authorization, bytes: body.length });
      const seconds = body.subarray(0, 4).toString('ascii') === 'RIFF' ? Math.round((body.length - 44) / 32000) : 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: `第${calls.length}段（${seconds}秒）`, durationSeconds: seconds }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  fs.writeFileSync(
    path.join(process.env.ARTEMIS_HOME!, 'providers.json'),
    JSON.stringify({ profiles: [], speech: { provider: 'platform', enabled: true, baseUrl, apiKey: 'ak-test', sttModel: 'asr-test', managedBy: 'platform' } }),
  );
  const workspace = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  const config = { baseUrl, apiKey: 'ak-test', sttModel: 'asr-test' };

  // A short WAV the tool sends as one piece.
  const short = path.join(workspace, 'note.wav');
  const pcm = Buffer.alloc(3 * 32000, 1);
  fs.writeFileSync(short, Buffer.concat([wavHeader(pcm.length), pcm]));

  if (hasFfmpeg) {
    const result = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: 'note.wav' }, { cwd: workspace });
    assert(
      'a short recording: one call with the platform key and model, the text inline, no file saved',
      result.ok && result.output.includes('第1段（3秒）') && calls.length === 1 && calls[0]!.model === 'asr-test' && calls[0]!.type === 'audio/wav' && !result.output.includes('saved'),
      result.output,
    );

    // Eleven minutes with pauses, as an MP3 (ffmpeg turns it back into WAV pieces).
    const longMp3 = path.join(workspace, 'meeting.mp3');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=270',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=388',
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]', '-map', '[a]', '-ac', '1', '-b:a', '32k', longMp3,
    ]);
    calls.length = 0;
    failNext = 1; // the first piece fails once and is retried
    const long = await transcribeFileWithPlatform(longMp3, config, { retryDelayMs: 10 });
    assert(
      'a long MP3: WAV pieces cut in the pause, each under 12 MB, retried once after a passing failure, timestamps per part',
      long.pieces.length === 3 &&
        calls.length === 3 &&
        calls.every((c) => c.type === 'audio/wav' && c.bytes < 12 * 1024 * 1024) &&
        Math.abs(long.pieces[1]!.startSeconds - 270) <= 2 &&
        long.text.startsWith('[0:00] 第1段') &&
        long.text.includes('[4:3') &&
        Math.round(long.durationSeconds) === 660,
      { text: long.text, starts: long.pieces.map((p) => p.startSeconds) },
    );

    calls.length = 0;
    const tool = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: longMp3 }, { cwd: workspace });
    const savedPath = /Full transcript saved: (.+)$/m.exec(tool.output)?.[1];
    assert(
      'the tool saves a multi-part transcript where the owner can open it',
      tool.ok && !!savedPath && savedPath.startsWith(path.join(tmpRoot, 'media', 'transcripts')) && fs.readFileSync(savedPath, 'utf8').includes('第3段') && !/gateway/i.test(tool.output),
      tool.output,
    );

    // A video: its audio track is transcribed.
    const video = path.join(workspace, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', video,
    ]);
    calls.length = 0;
    const fromVideo = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: 'clip.mp4' }, { cwd: workspace });
    assert('a video file: its audio track goes as WAV', fromVideo.ok && calls.length === 1 && calls[0]!.type === 'audio/wav' && fromVideo.output.includes('（4秒）'), fromVideo.output);

    const silent = path.join(workspace, 'silent.mp4');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-c:v', 'mpeg4', silent]);
    calls.length = 0;
    const noAudio = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: silent }, { cwd: workspace });
    assert('a video without sound: a plain failure, nothing sent', !noAudio.ok && /no audio/i.test(noAudio.output) && calls.length === 0, noAudio.output);
  } else {
    console.log('  (ffmpeg not installed: file conversion cases skipped)');
  }

  outage = true;
  const down = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: short }, { cwd: workspace });
  assert(
    'an outage without local Whisper: a plain failure, never a made-up transcript',
    !down.ok && down.output.startsWith('Transcription failed: platform speech recognition is not available right now'),
    down.output,
  );
  outage = false;

  const missing = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: 'nope.wav' }, { cwd: workspace });
  assert('a missing file says so', !missing.ok && missing.output.startsWith('Audio file not found'));

  // A workspace providers.json cannot redirect the platform key.
  fs.writeFileSync(path.join(process.env.ARTEMIS_HOME!, 'providers.json'), JSON.stringify({ profiles: [], speech: { provider: 'platform', enabled: false, managedBy: 'platform' } }));
  calls.length = 0;
  const off = await executeTranscribeAudio({ type: 'transcribe_audio', inputPath: short }, { cwd: workspace }).then(
    (r) => r.output,
    (e: unknown) => String(e),
  );
  assert('platform speech turned off: local Whisper is used (here: its install guidance)', calls.length === 0 && off.includes('No local STT engine found'), off);
  server.close();
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
