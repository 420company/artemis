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

const { platformSpeechFromStore, transcribeWithPlatform, PlatformSpeechError, platformSpeechFallsBack, languageTag, synthesizeWithPlatform } = await import('../src/core/platformSpeech.js');
const { planCuts, planSpeechWav, readSpeechPiece, probeMedia, UnsafeMediaError, wavHeader, parseWavHeader, formatTimestamp, SPEECH_SAMPLE_RATE } = await import('../src/core/audioChunks.js');
const { splitSpeechText, pickEdgeVoice, isMostlyChinese, EDGE_TTS_MAX_PIECE_BYTES, edgeTtsOptedIn, synthesizeEdgeTtsAudio } = await import('../src/core/edgeTts.js');
const { executeTranscribeAudio, transcribeFileWithPlatform } = await import('../src/tools/transcribeAudio.js');
const { executeSynthesizeSpeech } = await import('../src/tools/synthesizeSpeech.js');
const { transcribeLocalAudio } = await import('../src/core/localStt.js');

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
      eq(platformSpeechFromStore({ speech: { ...entry, sttModel: undefined, ttsModel: 'tts-1' } }), { baseUrl: 'https://gw.example/v1', apiKey: 'ak-1', ttsModel: 'tts-1' }) &&
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
  const { pieces, durationSeconds } = await planSpeechWav(wav);
  const starts = pieces.map((p) => Math.round(p.startSeconds));
  const read = await Promise.all(pieces.map((p) => readSpeechPiece(wav, p)));
  const sizes = read.map((b) => b.length);
  assert('planning writes nothing: the pieces are read from the one WAV when sent', fs.readdirSync(dir).length === 1);
  assert(
    'an 11-minute WAV becomes three pieces cut in its pauses, each a valid WAV under 12 MB',
    pieces.length === 3 &&
      Math.round(durationSeconds) === 660 &&
      Math.abs(starts[1]! - 270) <= 2 &&
      Math.abs(starts[2]! - 550) <= 2 &&
      sizes.every((s) => s < 12 * 1024 * 1024) &&
      pieces.every((p) => p.durationSeconds <= 300) &&
      Math.round(pieces.reduce((t, p) => t + p.durationSeconds, 0)) === 660 &&
      read.every((b) => parseWavHeader(b.subarray(0, 64), b.length).dataBytes === b.length - 44),
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
    const long = await transcribeFileWithPlatform(longMp3, config, { retryDelayMs: 10, concurrency: 1 });
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

console.log('review fixes: limits, safety, cleanup');
{
  // Language hints: only a language tag goes into a header.
  let sentLanguage: string | undefined = 'unset';
  const fake = (async (_url: string, init: RequestInit) => {
    sentLanguage = (init.headers as Record<string, string>)['x-language'];
    return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = { baseUrl: 'https://gw.example/v1', apiKey: 'k', sttModel: 'm' };
  const bad = await transcribeWithPlatform(new Uint8Array(10), 'audio/wav', cfg, { language: '中文', fetchImpl: fake }).then((r) => r.text, (e: Error) => `ERR ${e.message}`);
  assert('a non-ASCII language ("中文") is dropped, never a header error', bad === 'ok' && sentLanguage === undefined, bad);
  await transcribeWithPlatform(new Uint8Array(10), 'audio/wav', cfg, { language: 'zh-CN', fetchImpl: fake });
  assert('a language tag is sent', sentLanguage === 'zh-CN' && languageTag('Chinese') === undefined && languageTag('en') === 'en' && languageTag('zh-Hans-CN') === 'zh-Hans-CN');
}

if (hasFfmpeg) {
  const work = fs.mkdtempSync(path.join(tmpRoot, 'safety-'));
  // A playlist and a file list: they name other files and URLs, and are never opened.
  let hits = 0;
  const listener = http.createServer((_req, res) => {
    hits++;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const lport = (listener.address() as { port: number }).port;
  const m3u8 = path.join(work, 'list.m3u8');
  fs.writeFileSync(m3u8, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${lport}/a.ts\n#EXT-X-ENDLIST\n`);
  const concat = path.join(work, 'list.ffconcat');
  fs.writeFileSync(concat, `ffconcat version 1.0\nfile '${path.join(work, 'nothing.wav')}'\n`);
  const verdict = async (file: string) =>
    probeMedia(file).then(
      () => 'opened',
      (e: Error) => (e instanceof UnsafeMediaError ? 'unsafe' : e.name),
    );
  const [hls, list] = [await verdict(m3u8), await verdict(concat)];
  assert('ffprobe refuses playlists (hls) and file lists (concat), and fetches nothing', hls !== 'opened' && list !== 'opened' && hits === 0, { hls, list, hits });
  const cfg = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', sttModel: 'm' };
  const viaTool = await transcribeFileWithPlatform(m3u8, cfg, { tmpRoot: path.join(work, 'tmp') }).then(() => 'resolved', (e: Error) => (e as { code?: string }).code ?? e.message);
  assert('transcription of a playlist is refused without a request', ['unsupported_format', 'invalid_audio'].includes(viaTool) && hits === 0, viaTool);
  listener.close();

  // Long audio, against a slow fake gateway: the cap, concurrency, stopping and cleanup.
  let inFlight = 0;
  let peak = 0;
  let served = 0;
  const slow = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight--;
        served++;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: `段${served}`, durationSeconds: 1 }));
      }, 600); // long enough that pieces overlap even on a loaded machine
    });
  });
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const scfg = { baseUrl: `http://127.0.0.1:${(slow.address() as { port: number }).port}/v1`, apiKey: 'k', sttModel: 'm' };
  // Six minutes of tone with pauses every minute: pieces of at most 60 s.
  const sixMin = path.join(work, 'six.mp3');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=360', '-af', 'volume=enable=\'lt(mod(t,60),1)\':volume=0', '-ac', '1', '-b:a', '32k', sixMin]);
  const tmpDir = path.join(work, 'tmp');
  const tooLong = await transcribeFileWithPlatform(sixMin, scfg, { tmpRoot: tmpDir, maxSeconds: 120 }).then(() => 'resolved', (e: Error & { code?: string }) => e.code);
  assert('a recording over the cap is refused before it is converted or sent', tooLong === 'too_large' && served === 0 && fs.readdirSync(tmpDir).length === 0, tooLong);

  // Pieces of 60 s via a small cap on piece length is internal; use the 11-minute style file instead: 6 x 60 s.
  const ok = await transcribeFileWithPlatform(sixMin, scfg, { tmpRoot: tmpDir, concurrency: 3, maxSeconds: 400 });
  assert('pieces go a few at a time (never more than three), in order, and the temp folder is emptied', ok.pieces.length >= 2 && peak >= 2 && peak <= 3 && fs.readdirSync(tmpDir).length === 0, { pieces: ok.pieces.length, peak });

  served = 0;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const stopped = await transcribeFileWithPlatform(sixMin, scfg, { tmpRoot: tmpDir, signal: controller.signal, maxSeconds: 400, concurrency: 1 }).then(() => 'resolved', (e: Error) => e.name);
  assert('stopping the run stops ffmpeg and the pieces, and cleans up', stopped === 'AbortError' && served <= 1 && fs.readdirSync(tmpDir).length === 0, { stopped, served });
  slow.close();

  // Local Whisper: its converted WAV and transcript live in a temp folder that is always removed.
  const bin = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
  const fakeWhisper = path.join(bin, 'whisper-cli');
  fs.writeFileSync(fakeWhisper, '#!/bin/sh\nout=""\nin=""\nwhile [ $# -gt 0 ]; do case "$1" in -of) out="$2"; shift;; -f) in="$2"; shift;; esac; shift; done\ncase "$in" in *.wav) echo "local words" > "$out.txt";; *) echo "not wav" > "$out.txt";; esac\n');
  fs.chmodSync(fakeWhisper, 0o755);
  const model = path.join(bin, 'ggml-base.bin');
  fs.writeFileSync(model, 'x');
  const localTmp = fs.mkdtempSync(path.join(tmpRoot, 'local-tmp-'));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = localTmp;
  try {
    const local = await transcribeLocalAudio({ inputPath: sixMin, command: fakeWhisper, engine: 'whisper.cpp', modelPath: model });
    assert('local Whisper gets a converted WAV and leaves nothing behind in tmp', local.text === 'local words' && fs.readdirSync(localTmp).length === 0, { text: local.text, left: fs.readdirSync(localTmp) });
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
}

console.log('text to speech: licensed first, Edge only on opt-in');
{
  assert('the Edge voices are off unless the operator opts in', !edgeTtsOptedIn(undefined, {}) && edgeTtsOptedIn(true, {}) && edgeTtsOptedIn(undefined, { ARTEMIS_EDGE_TTS: '1' }) && !edgeTtsOptedIn(false, { ARTEMIS_EDGE_TTS: '0' }));
  assert(
    'voices follow the script: kana Japanese, hangul Korean, other Latin languages multilingual',
    pickEdgeVoice('こんにちは、元気ですか。日本語のテキスト') === 'ja-JP-NanamiNeural' &&
      pickEdgeVoice('안녕하세요 반갑습니다') === 'ko-KR-SunHiNeural' &&
      pickEdgeVoice('Bonjour à tous, comment ça va ?') === 'en-US-AvaMultilingualNeural' &&
      pickEdgeVoice('Hello there, how are you?') === 'en-US-AriaNeural' &&
      pickEdgeVoice('今天天气很好') === 'zh-CN-XiaoxiaoNeural',
  );

  // Edge over a stand-in connection: only turn.end completes a piece.
  const { Duplex } = await import('node:stream');
  const fakeEdge = (ending: 'turn.end' | 'close') => () => {
    let writes = 0;
    const sock = new Duplex({
      read() {},
      write(_chunk, _enc, cb) {
        writes++;
        if (writes === 1) sock.push(Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
        if (writes === 3) {
          const header = Buffer.from('Path:audio\r\n');
          const payload = Buffer.concat([Buffer.from([0, header.length]), header, Buffer.from('MP3DATA')]);
          sock.push(Buffer.concat([Buffer.from([0x82, payload.length]), payload]));
          if (ending === 'turn.end') {
            const text = Buffer.from('Path:turn.end\r\n\r\n{}');
            sock.push(Buffer.concat([Buffer.from([0x81, text.length]), text]));
          } else {
            sock.push(Buffer.from([0x88, 0]));
          }
        }
        cb();
      },
    });
    setImmediate(() => sock.emit('secureConnect'));
    return sock;
  };
  const whole = await synthesizeEdgeTtsAudio({ text: 'Hello.', connect: fakeEdge('turn.end') }).then((r) => r.audio.toString(), (e: Error) => `ERR ${e.message}`);
  const cut = await synthesizeEdgeTtsAudio({ text: 'Hello.', connect: fakeEdge('close') }).then((r) => r.audio.toString(), (e: Error) => `ERR ${e.message}`);
  assert('Edge: audio counts only after turn.end; a close before it is a failure, not half a reply', whole === 'MP3DATA' && cut.startsWith('ERR'), { whole, cut });

  // synthesize_speech through the platform's licensed voices.
  const seen: Record<string, unknown>[] = [];
  const tts = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/v1/audio/speech' || req.headers.authorization !== 'Bearer ak-tts') return void res.writeHead(404).end();
      seen.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from('ID3speech'));
    });
  });
  await new Promise<void>((resolve) => tts.listen(0, '127.0.0.1', resolve));
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'tts-ws-'));
  const store = (speech: unknown) => fs.writeFileSync(path.join(process.env.ARTEMIS_HOME!, 'providers.json'), JSON.stringify({ profiles: [], speech }));
  store({ provider: 'platform', enabled: true, baseUrl: `http://127.0.0.1:${(tts.address() as { port: number }).port}/v1`, apiKey: 'ak-tts', ttsModel: 'tts-1', managedBy: 'platform' });
  const spoken = await executeSynthesizeSpeech({ type: 'synthesize_speech', text: '你好，世界。', voice: 'shimmer', rate: 1.2 }, { cwd: ws });
  const out = /Speech synthesized: (.+)$/m.exec(spoken.output)?.[1];
  assert(
    'synthesize_speech speaks through the platform voices into the media folder',
    spoken.ok && !!out && out.startsWith(path.join(tmpRoot, 'media', 'audio')) && fs.readFileSync(out).toString() === 'ID3speech' && eq(seen.at(-1), { model: 'tts-1', input: '你好，世界。', voice: 'shimmer', response_format: 'mp3', speed: 1.2 }),
    { output: spoken.output, seen },
  );
  store({ provider: 'platform', enabled: true, baseUrl: 'https://gw.example/v1', apiKey: 'k', sttModel: 'asr', managedBy: 'platform' });
  const none = await executeSynthesizeSpeech({ type: 'synthesize_speech', text: '你好' }, { cwd: ws });
  assert('without a platform voice and without the opt-in: a plain "not set up", never the unlicensed service', !none.ok && /not set up/.test(none.output) && /ARTEMIS_EDGE_TTS/.test(none.output), none.output);
  tts.close();
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
