#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  extractDynamicSessionKeywords,
  runHallucinationImageTest,
  runHallucinationVideoTest,
  resolveImageConfigFromEnv,
  resolveVideoConfigFromEnv,
} from '../dist/hallucination-visual-test.js';

function nowIso() {
  return new Date().toISOString();
}

function sampleEvolution() {
  const timestamp = nowIso();
  return {
    version: '1.0.0',
    feedbackHistory: [
      { type: 'calibrate', preset: 'design', note: 'the bridge between Artemis dream and Phosphene hallucination should feel alive, not duplicated', timestamp },
      { type: 'amplify', preset: 'design', note: '猫 as living feedback, warm threshold, shadow that protects secrets', timestamp },
    ],
    sessionHistory: [
      {
        id: `visual-test-${Date.now()}`,
        startedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
        closedAt: timestamp,
        preset: 'design',
        signals: [
          { type: 'calibrate', preset: 'design', note: '幻觉层要吸取桥、门槛、猫、温度、影子，但不能重复 Artemis 主梦', timestamp },
          { type: 'amplify', preset: 'design', note: 'make the afterimage cinematic, tactile, chromatic, and project-local', timestamp },
        ],
        crystallized: [
          'Artemis keeps the primary dream; Phosphene produces the hallucination afterimage.',
          'The visual model should transform session keywords into sensory residue.',
        ],
        anchored: [
          'Do not duplicate Artemis dream memory; upgrade it through hallucination overlay.',
        ],
        outcome: 'productive',
      },
    ],
    currentSession: null,
    personalPresets: {},
    voiceDrift: {},
    emergentVoices: [],
    crystallizedInsights: [
      '[visual-test] Bridge, threshold, cat, ember, temperature, and shadow become visual residues.',
    ],
    optimalPoints: [
      {
        preset: 'design',
        layerSnapshot: { synesthesia: 0.8, apophenia: 0.7 },
        voiceSnapshot: { 'pattern-reader': 0.8 },
        timestamp,
        context: 'testing hallucination overlay visual generation from dynamic session keywords',
      },
    ],
    appliedProposals: [],
    lastEvolvedAt: null,
    evolutionCount: 0,
  };
}

function loadEvolution() {
  const statePath = join(process.cwd(), '.artemis', 'phosphene-state.json');
  if (existsSync(statePath)) {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (parsed.evolution) return { evolution: parsed.evolution, source: statePath };
  }
  return { evolution: sampleEvolution(), source: 'generated-session-fixture' };
}

function writeReport(report) {
  const outDir = join(homedir(), 'phosphene-generated', 'hallucination', 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `visual-test-report-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  return outPath;
}

async function main() {
  const modeArg = process.argv.find(arg => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.split('=')[1] : 'all';
  const { evolution, source } = loadEvolution();
  const keywords = extractDynamicSessionKeywords(evolution);

  if (keywords.length === 0) {
    throw new Error('No dynamic session keywords extracted; aborting visual generation test.');
  }

  const report = {
    ok: false,
    source,
    mode,
    keywords,
    image: null,
    video: null,
    errors: [],
  };

  if (mode === 'image' || mode === 'all') {
    try {
      const imageConfig = resolveImageConfigFromEnv();
      const image = await runHallucinationImageTest(evolution, imageConfig);
      report.image = {
        ok: image.ok,
        provider: image.image.backend,
        tool: image.image.tool,
        path: image.image.path,
        prompt: image.prompt.prompt,
      };
    } catch (error) {
      report.errors.push({ stage: 'image', message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (mode === 'video' || mode === 'all') {
    try {
      const video = await runHallucinationVideoTest(evolution, resolveVideoConfigFromEnv());
      report.video = {
        ok: video.ok,
        provider: video.provider,
        dryRun: video.dryRun,
        responsePath: video.responsePath,
        path: video.video?.path,
        tool: video.video?.tool,
        prompt: video.prompt.prompt,
      };
    } catch (error) {
      report.errors.push({ stage: 'video', message: error instanceof Error ? error.message : String(error) });
    }
  }

  report.ok = report.errors.length === 0;
  const reportPath = writeReport(report);

  console.log('[phosphene-hallucination-visual-test]');
  console.log(`  Source:   ${source}`);
  console.log(`  Keywords: ${keywords.map(keyword => keyword.term).join(', ')}`);
  if (report.image) console.log(`  Image:    ${report.image.path}`);
  if (report.video) console.log(`  Video:    ${report.video.dryRun ? `dry-run payload ${report.video.responsePath}` : report.video.path}`);
  console.log(`  Report:   ${reportPath}`);

  if (!report.ok) {
    console.error(JSON.stringify(report.errors, null, 2));
    process.exit(1);
  }
}

main().catch(error => {
  console.error('[phosphene-hallucination-visual-test] Fatal:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
