/**
 * The whole Saga pipeline, end to end, without one network call.
 *
 * Everything local stays real: the wizard's answers become an action, the
 * narrative pass, the continuity bible, the per-segment prompts, the frame
 * chain, the ffmpeg assembly, the transitions, the lint and the manifest. The
 * only thing replaced is the step where a video generation would leave this
 * machine -- and it is replaced by ffmpeg writing a real clip of the right
 * length and shape, so every stage downstream of it does its real work on
 * real files.
 *
 * What this is for: the segment loop is the most expensive code in the
 * project to be wrong about. A bug there is found by someone paying for a
 * hundred clips. This run finds it for free, and it is what makes a refactor
 * of that loop safe to make at all.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GenerateVideoAction, ToolExecutionContext } from '../src/core/types.js';
import { executeGenerateLongVideo, setSagaFinalRenderSkippedForTests } from '../src/tools/generateLongVideo.js';
import { setVideoGenerationStubForTests } from '../src/tools/generateVideo.js';

const execFileAsync = promisify(execFile);

/**
 * Every request the pipeline would have sent.
 *
 * Keyed by segment, never by arrival: chains are filmed concurrently, so the
 * order requests come in is not the order of the film. An assertion written
 * against arrival order passes or fails by timing, which is worse than no
 * assertion.
 */
type Captured = {
  segment: number;
  prompt: string;
  duration: number;
  resolution?: string | undefined;
  ratio?: string | undefined;
  referenceImagePaths: string[];
  referenceAudioPaths: string[];
  generateAudio?: boolean | undefined;
  cleanDirect?: boolean | undefined;
  outputPath: string;
};

async function ffmpeg(): Promise<string> {
  const { resolveFfmpegBinaryPath } = await import('../src/tools/visual/sagaRenderer/concat.js');
  return resolveFfmpegBinaryPath();
}

/** A real clip, so probes, last-frame extraction and concat all work. */
async function writeClip(bin: string, outputPath: string, seconds: number, ratio: string): Promise<void> {
  const size = ratio === '9:16' ? '288x512' : ratio === '1:1' ? '384x384' : '512x288';
  await mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(bin, [
    '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24:duration=${seconds.toFixed(3)}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds.toFixed(3)}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', outputPath,
  ], { timeout: 180_000 });
}

/** A workspace with a video provider configured, so nothing asks for setup. */
async function makeWorkspace(root: string, model: string): Promise<void> {
  const visual = {
    enabled: true,
    image: {
      provider: 'routerai', apiKey: 'dry-run', baseUrl: 'https://example.invalid/v1',
      model: 'seedream-4-5', defaultParams: {},
    },
    video: {
      enabled: true, provider: 'routerai', apiKey: 'dry-run',
      baseUrl: 'https://example.invalid/v1', model, defaultParams: {},
    },
  };
  await mkdir(path.join(root, '.artemis'), { recursive: true });
  await writeFile(
    path.join(root, '.artemis', 'providers.json'),
    JSON.stringify({ version: 1, profiles: [], visualProfile: visual }, null, 2),
    'utf8',
  );
}

function context(cwd: string): ToolExecutionContext {
  return { cwd, locale: 'zh-CN' } as unknown as ToolExecutionContext;
}

async function run(options: {
  model: string;
  action: Record<string, unknown>;
  /** Files the run needs inside its own workspace (the workspace guard is real). */
  prepare?: (root: string, bin: string) => Promise<Record<string, unknown>>;
}): Promise<{ captured: Captured[]; output: string; ok: boolean; projectDir: string }> {
  const bin = await ffmpeg();
  const root = await mkdtemp(path.join(tmpdir(), 'saga-dryrun-'));
  const captured: Captured[] = [];
  let projectDir = '';
  try {
    await makeWorkspace(root, options.model);
    const extra = options.prepare ? await options.prepare(root, bin) : {};
    setVideoGenerationStubForTests(async (action: GenerateVideoAction) => {
      captured.push({
        segment: Number(/(\d{3})\.mp4$/.exec(action.outputPath ?? '')?.[1] ?? 0),
        prompt: action.prompt ?? '',
        duration: action.duration ?? 0,
        resolution: action.resolution,
        ratio: action.ratio,
        referenceImagePaths: [...(action.referenceImagePaths ?? [])],
        referenceAudioPaths: [...(action.referenceAudioPaths ?? [])],
        generateAudio: action.generateAudio,
        cleanDirect: action.cleanDirect,
        outputPath: action.outputPath ?? '',
      });
      if (!action.outputPath) return { action, ok: false, output: 'dry run: no output path' };
      projectDir = path.dirname(path.dirname(action.outputPath));
      await writeClip(bin, action.outputPath, action.duration ?? 5, action.ratio ?? '16:9');
      return { action, ok: true, output: `dry run: wrote ${action.outputPath}` };
    });
    const result = await executeGenerateLongVideo(
      {
        type: 'generate_long_video',
        // Into the throwaway workspace, never the owner's real media folder.
        outputPath: path.join(root, 'out.mp4'),
        ...options.action,
        ...extra,
      } as never,
      context(root),
    );
    // In the film's order, so an assertion means what it says.
    captured.sort((a, b) => a.segment - b.segment);
    return { captured, output: result.output ?? '', ok: result.ok === true, projectDir };
  } finally {
    setVideoGenerationStubForTests(undefined);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const SCRIPT = [
  '【整片叙事】',
  '阿雨在雨夜回到老屋，发现父亲留下的笔记本还摊在桌上。',
  '',
  '[0-10秒]',
  '段 1 · 雨夜门口',
  '阿雨站在画面左侧，面朝门，中景，固定机位。她把钥匙插进锁孔，手指冻得发僵。',
  '【声音】雨声、金属摩擦声。',
  '**对白**: 「我回来了。」',
  '',
  '[10-20秒]',
  '段 2 · 走进屋里',
  '阿雨从左向右走进屋内，跟拍，中近景。台灯的黄光落在桌面摊开的笔记本上。',
  '【声音】脚步声、纸张轻响。',
  '',
  '[20-30秒]',
  '段 3 · 笔记本特写',
  '桌面笔记本特写，固定机位，俯拍。她的手伸进画面，指尖停在一行字上。',
  '【声音】室内安静，远处雨声。',
].join('\n');

/**
 * A film the way the panel would have asked for it: a written script with
 * timecodes, a ratio, a duration, subtitles off.
 */
async function scriptedRun(): Promise<void> {
  const { captured, output, ok } = await run({
    model: 'dreamina-seedance-2-0-260128',
    action: {
      story: SCRIPT,
      title: '雨夜回家',
      duration: 30,
      ratio: '9:16',
      resolution: '480p',
      subtitleMode: 'off',
      preserveUserScript: true,
    },
  });
  assert.equal(ok, true, `整条管线应当跑通：\n${output}`);
  assert.equal(captured.length, 3, `写好的三段剧本就是三段，得到 ${captured.length}`);

  // The written shot lengths survive: a user's script is not repacked.
  assert.deepEqual(captured.map((request) => request.duration), [10, 10, 10]);
  for (const request of captured) {
    assert.equal(request.ratio, '9:16', '画幅一路传到底');
    assert.equal(request.resolution, '480p');
    assert.ok(request.prompt.length > 0);
  }

  // Each segment carries its own beat and nobody else's.
  assert.match(captured[0]!.prompt, /钥匙|锁孔/);
  assert.match(captured[1]!.prompt, /台灯|走进/);
  assert.match(captured[2]!.prompt, /笔记本|特写/);
  assert.doesNotMatch(captured[2]!.prompt, /钥匙插进锁孔/, '第三段不该带第一段的动作');

  // Only the first segment's own line is its dialogue; the others have none.
  assert.match(captured[0]!.prompt, /我回来了/);
  assert.doesNotMatch(captured[1]!.prompt, /我回来了/, '台词不串段');

  // The frame chain: segment 1 has nothing to inherit, 2 and 3 do.
  assert.equal(captured[0]!.referenceImagePaths.length, 0, '第一段没有上一段的末帧');
  assert.ok(captured[1]!.referenceImagePaths.length > 0, '第二段吃到了末帧');
  assert.ok(
    captured[1]!.referenceImagePaths.some((p) => /\.(png|jpe?g|webp)$/i.test(p)),
    `末帧是图片：${captured[1]!.referenceImagePaths.join(', ')}`,
  );

  // The film was actually assembled, and the summary says what it made.
  assert.match(output, /Segments:\s+3/);
  assert.match(output, /📁 Output:/);
  assert.match(output, /Lint:\s+lint: 0 errors/);
  if (process.env.SAGA_DRYRUN_VERBOSE) console.log(output);
}

/** [原样直传]: the script goes as written and nothing is added. */
async function rawRun(): Promise<void> {
  const { captured, ok, output } = await run({
    model: 'dreamina-seedance-2-0-260128',
    action: {
      story: `[原样直传]\n\n${SCRIPT}`,
      title: '原样直传',
      duration: 30,
      ratio: '16:9',
      preserveUserScript: true,
    },
  });
  assert.equal(ok, true, output);
  for (const request of captured) {
    assert.equal(request.cleanDirect, true, '原样直传的段不带导演规格');
    assert.doesNotMatch(request.prompt, /NEGATIVE|PALETTE|CAMERA LOCK/i, '不附加锁');
  }
  // The owner's own words are still there.
  assert.match(captured[0]!.prompt, /我回来了/);
}

/** A soundtrack on a model that takes audio: every segment gets its slice. */
async function soundtrackRun(): Promise<void> {
  const { captured, ok, output } = await run({
    model: 'dreamina-seedance-2-5',
    action: {
      story: SCRIPT,
      title: '跟着音乐',
      duration: 30,
      ratio: '9:16',
      preserveUserScript: true,
      soundtrackStartSec: 5,
    },
    prepare: async (root, bin) => {
      const track = path.join(root, 'track.m4a');
      await execFileAsync(bin, [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
        '-c:a', 'aac', track,
      ], { timeout: 120_000 });
      return { soundtrackPath: track };
    },
  });
  assert.equal(ok, true, output);
  for (const request of captured) {
    assert.equal(request.referenceAudioPaths.length, 1, '每段都拿到它自己那段音乐');
    assert.match(request.referenceAudioPaths[0]!, /\.soundtrack\.m4a$/);
    assert.equal(request.generateAudio, false, '跟了音乐就不自己生成音频');
  }
  // Different slices, not the same file three times.
  const slices = new Set(captured.map((request) => request.referenceAudioPaths[0]));
  assert.equal(slices.size, captured.length, '三段三个不同的切片');
}

/** A segment the provider will never render, on a run told to carry on. */
async function skipRun(): Promise<void> {
  const bin = await ffmpeg();
  const root = await mkdtemp(path.join(tmpdir(), 'saga-dryrun-skip-'));
  const seen: number[] = [];
  const resolutions: Array<string | undefined> = [];
  try {
    await makeWorkspace(root, 'dreamina-seedance-2-0-260128');
    let call = 0;
    setVideoGenerationStubForTests(async (action: GenerateVideoAction) => {
      call += 1;
      // The second segment fails every attempt, including the cheaper one.
      const segment = Number(/(\d{3})\.mp4$/.exec(action.outputPath ?? '')?.[1] ?? 0);
      if (segment === 2) {
        resolutions.push(action.resolution);
        return { action, ok: false, output: 'dry run: provider refused this prompt' };
      }
      seen.push(segment);
      await writeClip(bin, action.outputPath!, action.duration ?? 5, action.ratio ?? '16:9');
      return { action, ok: true, output: 'dry run: ok' };
    });
    const result = await executeGenerateLongVideo(
      {
        type: 'generate_long_video',
        story: SCRIPT,
        title: '跳过一段',
        duration: 30,
        ratio: '16:9',
        preserveUserScript: true,
        onSegmentFailure: 'skip',
      } as never,
      context(root),
    );
    assert.equal(result.ok, true, `跳过一段之后其余段应当跑完：\n${result.output}`);
    assert.match(result.output ?? '', /有 1\/3 段没有生成出来（第 2 段）/);
    assert.match(result.output ?? '', /重跑会只补这几段/);
    assert.match(result.output ?? '', /Segments:\s+2\/3/);
    assert.deepEqual([...new Set(seen)].sort(), [1, 3], '第 1、3 段都拍了');
    // A generic provider refusal is a kind a smaller request can sometimes
    // pass, so segment 2 gets exactly one extra call at a lower resolution
    // and no more: 1 + 2 + 1.
    assert.equal(call, 4, `第 2 段应当多试一次降画质，总调用 ${call}`);
    assert.equal(
      resolutions.filter((value) => value === '480p').length,
      1,
      `降画质那一次用了 480p：${resolutions.join(', ')}`,
    );
  } finally {
    setVideoGenerationStubForTests(undefined);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A scene boundary breaks the frame chain. Not for speed: chapter six opens
 * somewhere else, on another day, with other people, so carrying chapter
 * five's closing frame into it is wrong.
 */
async function sceneBoundaryRun(): Promise<void> {
  const { captured, ok, output } = await run({
    model: 'dreamina-seedance-2-0-260128',
    action: {
      prompt: '三场互不相连的戏',
      title: '场景边界',
      duration: 30,
      ratio: '16:9',
      preserveUserScript: true,
      shots: [
        { title: '雨夜门口', duration: 10, storyBeat: '阿雨站在门口，中景，固定机位，把钥匙插进锁孔。', opensScene: true },
        { title: '走进屋里', duration: 10, storyBeat: '阿雨从左向右走进屋内，跟拍，台灯的黄光落在桌面上。' },
        { title: '三年后的沙漠', duration: 10, storyBeat: '沙丘脊线在正午白光里，骆驼影子很短，商队铃声从背后传来。', opensScene: true },
      ],
    },
  });
  assert.equal(ok, true, output);
  assert.equal(captured.length, 3);
  // Segment 2 continues segment 1, so it inherits the closing frame.
  assert.ok(captured[1]!.referenceImagePaths.length > 0, '同一场戏内部要接末帧');
  // Segment 3 opens a scene, so it inherits nothing.
  assert.equal(captured[0]!.referenceImagePaths.length, 0, '第一段没有上一段');
  assert.equal(captured[2]!.referenceImagePaths.length, 0, '开新场的段不该继承上一场的末帧');
  // The two chains were filmed independently: that is what the frame
  // references above show, and it is the only part worth asserting here --
  // the ordering and the bound are covered by the chain unit tests, and the
  // one-line summary goes to the log rather than into this result.
}

async function main(): Promise<void> {
  setSagaFinalRenderSkippedForTests(false);
  await scriptedRun();
  await rawRun();
  await soundtrackRun();
  await skipRun();
  await sceneBoundaryRun();
  console.log('saga pipeline dry run: ok');
}

await main();
