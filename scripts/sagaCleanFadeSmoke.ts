#!/usr/bin/env tsx
import path from 'node:path';
import { stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { renderSagaProject } from '../src/tools/visual/sagaRenderer/index.js';
import { planTransition } from '../src/tools/visual/sagaRenderer/transitions.js';
import type { SagaSegmentInput, SagaTransitionKind } from '../src/tools/visual/sagaRenderer/types.js';

const KINDS: SagaTransitionKind[] = ['crossfade', 'light-leak', 'cinematic-fade', 'fade-black', 'fade-white', 'dissolve'];

async function ensureExists(p: string): Promise<boolean> {
  try { const i = await stat(p); return i.isFile() && i.size > 1024; } catch { return false; }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const sourceDir = path.join(cwd, 'generated-media', 'long-videos', 'saga-hf-1778150504289', 'segments');
  const seg1 = path.join(sourceDir, '001.mp4');
  const seg2 = path.join(sourceDir, '002.mp4');
  if (!(await ensureExists(seg1)) || !(await ensureExists(seg2))) {
    console.error(`source segments missing under ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  const results: Array<{ kind: SagaTransitionKind; ok: boolean; reportedS?: number; actualS?: number; outputPath?: string; error?: string }> = [];

  for (const kind of KINDS) {
    const projectId = `saga-cf-${kind}`;
    const projectDir = path.join(cwd, 'generated-media', 'long-videos', '_clean-fade', projectId);
    const hyperframesProjectDir = path.join(projectDir, 'hyperframes');
    const outputPath = path.join(projectDir, 'final.mp4');
    await rm(projectDir, { recursive: true, force: true });
    await mkdir(path.join(hyperframesProjectDir, 'media', 'segments'), { recursive: true });

    const segments: SagaSegmentInput[] = [seg1, seg2].map((src, i): SagaSegmentInput => ({
      index: i + 1, title: `${kind} ${i + 1}`, duration: 5,
      storyBeat: '', visualPrompt: '', camera: '', continuity: '', transition: '', prompt: '', textOnlyPrompt: '',
      outputPath: src,
      mediaPath: path.join(hyperframesProjectDir, 'media', 'segments', `${String(i + 1).padStart(3, '0')}.mp4`),
    }));
    for (const segment of segments) await copyFile(segment.outputPath, segment.mediaPath);

    const transitions = [planTransition(kind)];
    try {
      const result = await renderSagaProject({
        projectId,
        ratio: '9:16',
        fps: 30,
        segments,
        transitions,
        hyperframesProjectDir,
        outputPath,
        workDir: projectDir,
        identityCard: '[clean-fade-smoke]',
        bible: '',
        hasAudio: true,
        colorMatch: false,
        encode: { quality: 'standard', gpu: 'auto' },
      });

      const probe = await import('node:child_process').then((m) => new Promise<string>((resolve) => {
        m.execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath], (err, stdout) => {
          if (err) resolve('NaN'); else resolve(stdout.trim());
        });
      }));
      results.push({ kind, ok: result.ok, reportedS: result.durationSeconds, actualS: parseFloat(probe), outputPath });
    } catch (e) {
      results.push({ kind, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log(`\nClean-fade matrix: ${results.filter((r) => r.ok).length}/${results.length} passed`);
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.kind}: reported=${r.reportedS?.toFixed(2)}s actual=${r.actualS?.toFixed(2)}s → ${r.outputPath}`);
    else console.log(`  ✗ ${r.kind}: ${r.error}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
