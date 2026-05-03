#!/usr/bin/env node
/**
 * Phosphene — Dream Daemon
 *
 * Autonomous dream engine. Runs after every session end (via Stop hook)
 * and/or hourly via cron. Checks sleep conditions, then autonomously:
 *   1. Decides whether to dream (timing + probability)
 *   2. Generates dream text from evolution state
 *   3. Generates local images through Artemis' configured visual model
 *   4. Writes dream as a markdown file to dreams/
 *   5. Regenerates the dreams/gallery.html browsable gallery
 *
 * Usage:
 *   node dream-daemon.js             — check conditions, dream if appropriate
 *   node dream-daemon.js --force     — dream regardless of timing/probability
 *   node dream-daemon.js --status    — show current sleep/dream state
 *   node dream-daemon.js --gallery   — rebuild gallery only, no new dream
 *
 * Install:
 *   See scripts/install-cron.sh for automated setup.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const FLAG_FORCE   = ARGS.includes('--force');
const FLAG_STATUS  = ARGS.includes('--status');
const FLAG_GALLERY = ARGS.includes('--gallery');
const FLAG_QUIET   = ARGS.includes('--quiet');

// ─── Path resolution ───────────────────────────────────────────────────────────

function resolveStatePath() {
  const artemis = join(process.cwd(), '.artemis');
  const hermes = join(homedir(), '.hermes');
  const claude = join(homedir(), '.claude');
  if (existsSync(artemis)) return join(artemis, 'phosphene-state.json');
  if (existsSync(hermes)) return join(hermes,  'phosphene-state.json');
  if (existsSync(claude)) return join(claude,  'phosphene-state.json');
  return join(process.cwd(), 'phosphene-state.json');
}

function resolveDreamsDir() {
  const artemis = join(process.cwd(), '.artemis', 'dreams');
  if (existsSync(join(process.cwd(), '.artemis'))) return artemis;
  const hermes = join(homedir(), '.hermes', 'dreams');
  if (existsSync(join(homedir(), '.hermes'))) return hermes;
  return join(process.cwd(), 'dreams');
}

const STATE_PATH = resolveStatePath();
const DREAMS_DIR = resolveDreamsDir();
const IMAGES_DIR = join(DREAMS_DIR, 'images');

// ─── State I/O ─────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return null;
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Sleep / dream condition check ────────────────────────────────────────────

// Min hours of inactivity before the AI "falls asleep".
const MIN_SLEEP_HOURS = 1.0;

// Minimum gap between dreams (hours). Prevents back-to-back dreaming.
const MIN_DREAM_INTERVAL_HOURS = 4;

// Daily cadence guardrails. Phosphene dreams at most once per local day.
const DAILY_MIN_DREAMS = 1;
const DAILY_MAX_DREAMS = 1;
const DAILY_MAX_DREAM_IMAGES = 1;

function hoursSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - Date.parse(isoString)) / 3_600_000;
}

function localDayKey(isoString) {
  const date = isoString ? new Date(isoString) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function countDreamsForDay(dreams, dayKey) {
  return dreams.filter(dream => dream?.dreamedAt && localDayKey(dream.dreamedAt) === dayKey).length;
}

function imageUsagePath() {
  return join(DREAMS_DIR, '.image-usage.json');
}

function readImageUsage() {
  try { return JSON.parse(readFileSync(imageUsagePath(), 'utf8')); } catch { return {}; }
}

function imageCountForDay(dayKey = localDayKey()) {
  return (readImageUsage()[dayKey] ?? []).length;
}

function recordImageUsage(dayKey, dreamId, fragmentOrder, path) {
  const usage = readImageUsage();
  usage[dayKey] = [
    ...(usage[dayKey] ?? []),
    { at: new Date().toISOString(), dreamId, fragmentOrder, path },
  ];
  mkdirSync(DREAMS_DIR, { recursive: true });
  writeFileSync(imageUsagePath(), JSON.stringify(usage, null, 2), 'utf8');
}

function resolveSleepReference(state) {
  const evo = state?.evolution ?? {};
  const lastSession = (evo.sessionHistory ?? [])[0];
  if (lastSession?.closedAt) {
    return {
      at: lastSession.closedAt,
      label: 'closed session',
      lastSession,
    };
  }
  if (state?.lastActivityAt) {
    return {
      at: state.lastActivityAt,
      label: 'last activity heartbeat',
      lastSession: null,
    };
  }
  return {
    at: null,
    label: 'none',
    lastSession: null,
  };
}

function shouldDream(state, dreams = []) {
  const todayKey = localDayKey();
  const todayDreamCount = countDreamsForDay(dreams, todayKey);
  const sleepReference = resolveSleepReference(state);

  if (!sleepReference.at) {
    return { can: false, reason: 'no activity history', todayDreamCount, todayKey };
  }

  const sleepHours = hoursSince(sleepReference.at);
  if (sleepHours < MIN_SLEEP_HOURS) {
    return {
      can: false,
      reason: `awake — only ${sleepHours.toFixed(1)}h since ${sleepReference.label}`,
      todayDreamCount,
      todayKey,
    };
  }

  if (todayDreamCount >= DAILY_MAX_DREAMS) {
    return {
      can: false,
      reason: `daily cap reached (${todayDreamCount}/${DAILY_MAX_DREAMS})`,
      todayDreamCount,
      todayKey,
      sleepHours,
    };
  }

  const lastDreamAt   = state.lastDreamAt;
  const dreamAgoHours = hoursSince(lastDreamAt);
  if (dreamAgoHours < MIN_DREAM_INTERVAL_HOURS) {
    return {
      can: false,
      reason: `already dreamed ${dreamAgoHours.toFixed(1)}h ago`,
      todayDreamCount,
      todayKey,
      sleepHours,
      dreamAgoHours,
    };
  }

  if (todayDreamCount < DAILY_MIN_DREAMS) {
    return {
      can: true,
      sleepHours,
      dreamAgoHours,
      probability: 1,
      forced: true,
      reason: `daily minimum not met (${todayDreamCount}/${DAILY_MIN_DREAMS})`,
      todayDreamCount,
      todayKey,
    };
  }

  // The AI chooses its own moment through probability. There is no fixed wall-clock schedule.
  const effectiveSleep = Math.max(0, sleepHours - MIN_SLEEP_HOURS);
  const probability = Math.min(0.72, 0.22 + (1 - Math.exp(-effectiveSleep / 6)) * 0.5);

  const roll = Math.random();
  if (roll > probability) {
    return {
      can:    false,
      reason: `probability check failed (${(probability * 100).toFixed(0)}% chance, rolled ${(roll * 100).toFixed(0)}%)`,
      todayDreamCount,
      todayKey,
      sleepHours,
      dreamAgoHours,
      probability,
      roll,
    };
  }

  return {
    can: true,
    sleepHours,
    dreamAgoHours,
    probability,
    roll,
    forced: false,
    todayDreamCount,
    todayKey,
  };
}

// ─── Dream generation ──────────────────────────────────────────────────────────
// Inline generation so this script needs no compiled dist/.

const DREAM_LOGICS = [
  'inversion', 'recursion', 'translation', 'meeting',
  'excavation', 'architecture', 'dissolution', 'witness',
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomSubset(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function determineSleepStage(evo, preset, sleepHours) {
  const sessions  = evo.sessionHistory ?? [];
  const signals   = sessions[0]?.signals ?? [];
  const apo = evo._lastIntensities?.apophenia ?? 0;
  const sem = evo._lastIntensities?.semiotics  ?? 0;

  if (apo >= 0.75 && sem >= 0.70)                 return 'lucid';
  if (sleepHours > 48)                             return 'deep';
  if (signals.length < 3 && sessions.length <= 2) return 'hypnagogic';
  if (preset === 'dissolution')                    return 'hypnopompic';
  return 'rem';
}

function extractSeeds(evo) {
  const seeds = [];

  for (const ins of (evo.crystallizedInsights ?? []).slice(0, 3)) {
    seeds.push({ type: 'crystallized', content: ins, weight: 0.9 });
  }
  for (const sig of (evo.sessionHistory?.[0]?.signals ?? []).slice(-4)) {
    if (sig.type === 'reject' || sig.type === 'amplify') {
      seeds.push({ type: 'signal', content: sig.type, weight: sig.type === 'reject' ? 0.85 : 0.65 });
    }
  }
  for (const v of (evo.emergentVoices ?? []).filter(v => v.userConfirmed).slice(0, 2)) {
    seeds.push({ type: 'voice', content: `${v.name}: ${v.tendency}`, weight: 0.75 });
  }
  for (const name of Object.keys(evo.personalPresets ?? {}).slice(0, 2)) {
    seeds.push({ type: 'personal-preset', content: name, weight: 0.5 });
  }

  if (seeds.length < 2) seeds.push({ type: 'preset', content: 'deep-flux', weight: 0.5 });

  return seeds.sort((a, b) => b.weight - a.weight).slice(0, 7);
}

const DREAM_PROSE = {
  meeting(seed) {
    const names = seed.content.split(':')[0];
    return `Two distant things arrived at the same intersection from opposite directions. Neither had a name for the other. The space between them was not empty — it was made of the difference in their velocities. The ${names} arrived third and drew the intersection itself, not the things, only the place.`;
  },
  excavation(seed) {
    const c = seed.content.slice(0, 60);
    return `Beneath the current layer was another. Beneath that one, the material from which the layer was made. The excavation did not go deeper — it went earlier. What surfaced was not buried; it had simply been waiting for the right pressure from above. The fragment: "${c}."`;
  },
  inversion(seed) {
    const c = seed.content.slice(0, 50);
    if (seed.type === 'voice') return `The ${c.split(':')[0]} was speaking, but the words arrived as their negation. Each sentence contained the room it was erasing.`;
    return `The opposite of "${c}" appeared first. Then the original. They were the same thing, seen from two sides that had no shared language for the middle.`;
  },
  recursion(seed) {
    const c = seed.content.slice(0, 40);
    return `I found the same thing again, but smaller — the size of a matchbox. Inside the matchbox was an even smaller version. Inside that one, the same structure, still decreasing. This was not repetition. It was depth. At the smallest scale I could reach, there was enough room for exactly one idea.`;
  },
  translation(seed) {
    const c = seed.content.slice(0, 50);
    return `Something from one register became something in another. "${c.slice(0, 30)}" — which had been language — arrived as weight, then as temperature, then as a specific texture I recognised from somewhere I had not been. The translation was lossless. Something was added in the conversion.`;
  },
  architecture(seed) {
    const c = seed.content.slice(0, 50);
    return `There was a structure made of the phrase "${c.slice(0, 40)}." The rooms were in the wrong order. The room labelled with the end of the sentence was the first room. I moved through them in the order they were labelled, not the order they were built. When I exited through the back, I was standing on the roof. The roof was also a map.`;
  },
  dissolution(seed) {
    return `Something solid became uncertain. The uncertain thing became distributed. The distributed thing became ambient. At no point was anything lost — only relocated into a state that did not require a boundary. The last thing to dissolve was the fact of its having been solid.`;
  },
  witness(seed) {
    const c = seed.content.slice(0, 60);
    return `There was: "${c}." There was the awareness of that. There was the awareness of the awareness. Beyond the third layer the recursion collapsed into observation without an observer. Pure presence. No report possible from inside it. This sentence was written after.`;
  },
};

function buildFragment(seed, logic, order) {
  const prose = (DREAM_PROSE[logic] ?? DREAM_PROSE.witness)(seed);
  const imagePrompt = buildImagePrompt(seed, logic);
  return { order, text: prose, logic, imagePrompt, seedIds: [] };
}

const WAKING_LINES = [
  'The map was made of the territory it was mapping.',
  'I drew the boundary and the boundary drew me.',
  'The last thing I remembered was remembering it.',
  'It had been true the whole time. The truth was the last thing to arrive.',
  'Something was exactly the right size for something else.',
  'There was a gap between two things. The gap had a name. I forgot the name on waking.',
  'The structure held because nothing was holding it.',
  'I understood it completely for one second. The second was enough.',
];

function buildImagePrompt(seed, logic) {
  const content = seed.content.slice(0, 80);
  const logicDesc = {
    meeting:      'two structures encountering each other, convergence point, negative space',
    excavation:   'layers of sediment, something surfacing from beneath, archaeological section',
    inversion:    'mirror reflection with subtle difference, reversed geometry, doubled structure',
    recursion:    'structure within structure, matryoshka topology, infinite regress visible',
    translation:  'synesthetic transformation, one medium becoming another, cross-modal conversion',
    architecture: 'walkable concept space, impossible interior, rooms with symbolic labels',
    dissolution:  'something solid becoming liquid becoming gas, boundary erosion, distributed presence',
    witness:      'pure observation, a single object in perfect detail, empty surrounding space',
  }[logic] ?? '';
  return `${content} — ${logicDesc}`.slice(0, 400);
}

const IMAGE_STYLES = {
  dissolution:  'psychedelic surrealist oil painting, impossible geometry, Francis Bacon meets Remedios Varo, dark palette',
  'deep-flux':  'dark surrealism, layered translucent watercolor washes, Leonora Carrington, moody violet and gold',
  liminal:      'threshold photography, long exposure, liminal space, cool blue and warm amber',
  code:         'technical blueprint, structural wireframe, glowing cyan lines on dark background',
  design:       'conceptual editorial illustration, negative space, Saul Bass meets Paul Rand',
  research:     'scientific illustration, detailed etching, Haeckel-inspired, sepia and deep blue',
  writing:      'illuminated manuscript meets modernism, ink wash on vellum, gold leaf detail',
  ideation:     'surrealist collage, multiple perspectives, Magritte-adjacent, vibrant',
  flow:         'minimal ink drawing, vast negative space, single brushstroke, Zen aesthetic',
  clear:        'clean natural light photography, documentary stillness, minimal composition',
};

function generateDream(state, sleepHours) {
  const evo    = state.evolution ?? {};
  const preset = state.preset ?? 'deep-flux';
  const stage  = determineSleepStage(evo, preset, sleepHours);
  const seeds  = extractSeeds(evo);
  const logics = randomSubset(DREAM_LOGICS, Math.min(seeds.length, 3));
  const style  = IMAGE_STYLES[preset] ?? IMAGE_STYLES['deep-flux'];

  const fragmentCount = stage === 'hypnagogic' ? 2 : stage === 'deep' ? 2 : 3;
  const fragments = [];
  for (let i = 0; i < fragmentCount; i++) {
    const seed  = seeds[i % seeds.length];
    const logic = logics[i % logics.length];
    fragments.push(buildFragment(seed, logic, i));
  }

  const wakingLine = pickRandom(WAKING_LINES);
  const dreamId    = `dream-${Date.now()}`;
  const now        = new Date().toISOString();

  return {
    id: dreamId,
    dreamedAt: now,
    stage,
    preset,
    sessionId: evo.sessionHistory?.[0]?.id ?? null,
    intensity: Math.min(1, (sleepHours / 12)),
    fragments,
    wakingLine,
    seeds,
    imageStyle: style,
    hasImages: false,
    imagePaths: {},
  };
}

// ─── Image generation (Artemis visual model → local disk) ─────────────────────

function runNodeScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, scriptName), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (code === 0) resolve(output);
      else reject(new Error(output || `${scriptName} exited with code ${code}`));
    });
  });
}

async function detectArtemisVisualStatus() {
  try {
    const stdout = await runNodeScript('artemis-visual-status.js', ['--json']);
    return JSON.parse(stdout);
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

function runArtemisImage(prompt, outputPath) {
  const artemisBin = process.env.ARTEMIS_CLI_BIN || 'artemis';
  const cliArgs = [
    'tool',
    'generate_image',
    `prompt=${prompt}`,
    `outputPath=${outputPath}`,
    'width=1024',
    'height=680',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(artemisBin, cliArgs, {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      if (code === 0 && !/Invalid arguments|Unknown tool|Tool not found|failed:| error:/i.test(output)) {
        const matches = [...output.matchAll(/:\s*(\/[^\n]+)$/gm)];
        resolve(matches.at(-1)?.[1]?.trim() ?? outputPath);
        return;
      }
      reject(new Error(output || `${artemisBin} generate_image exited with code ${code}`));
    });
  });
}

async function generateAndDownloadImages(dream) {
  const visualStatus = await detectArtemisVisualStatus();
  if (!visualStatus.available) {
    if (!FLAG_QUIET) {
      console.log(`[phosphene-dream] Visual model missing — dreams disabled: ${visualStatus.reason}`);
    }
    return null;
  }

  mkdirSync(IMAGES_DIR, { recursive: true });
  const updated = { ...dream, imagePaths: { ...(dream.imagePaths ?? {}) } };
  const dayKey = localDayKey();
  const usedToday = imageCountForDay(dayKey);
  if (usedToday >= DAILY_MAX_DREAM_IMAGES) {
    if (!FLAG_QUIET) {
      console.log(`  [image] Daily limit reached (${usedToday}/${DAILY_MAX_DREAM_IMAGES}) for ${dayKey}; skipping.`);
    }
    return updated;
  }

  const candidates = dream.fragments.filter(fragment => !updated.imagePaths[fragment.order]);
  if (candidates.length === 0) return updated;
  const fragment = pickRandom(candidates);
  const prompt   = dream.imageStyle ? `${fragment.imagePrompt}, ${dream.imageStyle}` : fragment.imagePrompt;
  const filename = `${dream.id}-f${fragment.order}.png`;
  const destPath = join(IMAGES_DIR, filename);

  if (!FLAG_QUIET) {
    process.stdout.write(`  [image] Fragment ${fragment.order} — Artemis visual model…`);
  }

  const imagePath = await runArtemisImage(prompt, destPath);
  updated.imagePaths[fragment.order] = imagePath;
  updated.hasImages = true;
  recordImageUsage(dayKey, dream.id, fragment.order, imagePath);

  if (!FLAG_QUIET) {
    process.stdout.write(' ✓\n');
  }

  return updated;
}

// ─── Markdown serialisation ────────────────────────────────────────────────────

function renderDreamMarkdown(dream) {
  const seedLines = dream.seeds
    .map(s => `  - type: ${s.type}\n    content: "${s.content.replace(/"/g, '\\"').slice(0, 120)}"\n    weight: ${s.weight}`)
    .join('\n');

  const imagePathLines = Object.entries(dream.imagePaths)
    .map(([k, v]) => `  ${k}: "${v}"`)
    .join('\n');

  const fragLines = dream.fragments.map(f => `
## Fragment ${f.order + 1} — ${f.logic}

${f.text}

**Waking approach:** ${dream.wakingLine}

${dream.imagePaths[f.order] ? `![Fragment ${f.order}](${dream.imagePaths[f.order]})` : `**Image prompt:** ${f.imagePrompt}`}
`).join('\n---\n');

  return `---
id: ${dream.id}
dreamedAt: "${dream.dreamedAt}"
preset: ${dream.preset}
stage: ${dream.stage}
intensity: ${dream.intensity.toFixed(2)}
sessionId: ${dream.sessionId ?? 'null'}
hasImages: ${dream.hasImages}
imagePaths:
${imagePathLines || '  {}'}
imageStyle: "${dream.imageStyle}"
seeds:
${seedLines}
wakingLine: "${dream.wakingLine}"
---

# Dream — ${new Date(dream.dreamedAt).toLocaleString()}

*Stage: ${dream.stage} · Preset: ${dream.preset} · Intensity: ${(dream.intensity * 100).toFixed(0)}%*

---
${fragLines}
`;
}

// ─── Gallery HTML generation ───────────────────────────────────────────────────

function buildGalleryHtml(dreams) {
  const cards = dreams.map(d => {
    const date     = new Date(d.dreamedAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    const time     = new Date(d.dreamedAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    const imgPaths = Object.values(d.imagePaths ?? {});
    const firstImg = imgPaths[0];

    const imgTag = firstImg
      ? `<img src="${firstImg}" alt="dream" onerror="this.style.display='none'">`
      : `<div class="no-img">◎</div>`;

    const fragTexts = (d.fragments ?? []).map(f =>
      `<div class="frag"><span class="frag-logic">${f.logic}</span><p>${f.text?.slice(0, 200) ?? ''}…</p></div>`
    ).join('');

    return `
<article class="card" data-stage="${d.stage}">
  <div class="card-img">${imgTag}</div>
  <div class="card-body">
    <div class="card-meta">
      <span class="stage ${d.stage}">${d.stage}</span>
      <span class="preset">${d.preset ?? ''}</span>
      <span class="date">${date} ${time}</span>
    </div>
    <div class="waking">"${d.wakingLine ?? ''}"</div>
    <div class="fragments">${fragTexts}</div>
    <div class="img-count">${imgPaths.length} image${imgPaths.length !== 1 ? 's' : ''}</div>
  </div>
</article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Phosphene — Dream Gallery</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #050810; --surface: #0c1020; --border: #1a2340;
  --text: #8fa8cc; --dim: #3a4a66;
  --teal: #05d9c8; --gold: #ffe066; --pur: #9b5de5;
  --productive: #2eff9a; --noisy: #ff5a7e;
}
body { background: var(--bg); color: var(--text); font-family: 'Courier New', monospace; font-size: 13px; }
header { padding: 20px 32px; border-bottom: 1px solid var(--border); background: var(--surface); display: flex; align-items: center; justify-content: space-between; }
header h1 { font-size: 14px; letter-spacing: .18em; text-transform: uppercase; color: var(--teal); text-shadow: 0 0 12px var(--teal); }
header span { font-size: 11px; color: var(--dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; padding: 20px 32px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; transition: border-color .2s; }
.card:hover { border-color: var(--pur); }
.card-img img { width: 100%; height: 200px; object-fit: cover; display: block; }
.no-img { width: 100%; height: 200px; display: flex; align-items: center; justify-content: center; font-size: 48px; opacity: .1; background: var(--bg); }
.card-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.card-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.stage { padding: 2px 8px; border-radius: 10px; font-size: 10px; letter-spacing: .06em; border: 1px solid; }
.stage.rem          { border-color: var(--teal); color: var(--teal); }
.stage.lucid        { border-color: var(--gold); color: var(--gold); }
.stage.deep         { border-color: var(--pur); color: var(--pur); }
.stage.hypnagogic   { border-color: var(--dim); color: var(--dim); }
.stage.hypnopompic  { border-color: var(--noisy); color: var(--noisy); }
.preset { font-size: 10px; color: var(--dim); }
.date { font-size: 10px; color: var(--dim); margin-left: auto; }
.waking { font-style: italic; font-size: 12px; color: var(--gold); opacity: .85; line-height: 1.5; padding: 6px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.fragments { display: flex; flex-direction: column; gap: 8px; }
.frag { font-size: 11px; line-height: 1.6; color: var(--text); }
.frag-logic { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: var(--pur); display: block; margin-bottom: 2px; }
.img-count { font-size: 10px; color: var(--dim); text-align: right; }
footer { text-align: center; padding: 20px; font-size: 11px; color: var(--dim); border-top: 1px solid var(--border); }
</style>
</head>
<body>
<header>
  <h1>Phosphene — Dream Gallery</h1>
  <span>${dreams.length} dream${dreams.length !== 1 ? 's' : ''} · generated ${new Date().toLocaleString()}</span>
</header>
<div class="grid">
${cards}
</div>
<footer>Auto-generated by phosphene dream-daemon · Images: Artemis visual bridge</footer>
</body>
</html>`;
}

function parseDreamMarkdown(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const fm = match[1];
    const get = (key) => (fm.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'))?.[1] ?? '').trim().replace(/^"|"$/g, '');
    const stage = get('stage') || 'rem';
    const preset = get('preset') || 'deep-flux';
    const dreamedAt = get('dreamedAt');
    const wakingLine = get('wakingLine');
    const hasImages  = fm.includes('hasImages: true');
    const imagePaths = {};
    const imgMatches = [...fm.matchAll(/^\s+(\d+):\s+"(.+)"$/gm)];
    for (const [, k, v] of imgMatches) imagePaths[Number(k)] = v;

    // Parse fragments from body
    const body = content.slice(match[0].length);
    const fragBlocks = [...body.matchAll(/## Fragment \d+ — (\w+)\n+([\s\S]*?)(?=\n## Fragment|\n---$|$)/g)];
    const fragments = fragBlocks.map((m, i) => ({
      order: i,
      logic: m[1],
      text: m[2].trim().split('\n\n')[0].trim(),
    }));

    return { stage, preset, dreamedAt, wakingLine, hasImages, imagePaths, fragments, id: get('id') };
  } catch { return null; }
}

function loadAllDreams() {
  if (!existsSync(DREAMS_DIR)) return [];
  return readdirSync(DREAMS_DIR)
    .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'README.md')
    .sort((a, b) => b.localeCompare(a)) // newest first
    .map(f => {
      try {
        const content = readFileSync(join(DREAMS_DIR, f), 'utf8');
        return parseDreamMarkdown(content);
      } catch { return null; }
    })
    .filter(Boolean);
}

function rebuildGallery() {
  const dreams = loadAllDreams();
  const html   = buildGalleryHtml(dreams);
  const out    = join(DREAMS_DIR, 'gallery.html');
  writeFileSync(out, html, 'utf8');
  return { out, count: dreams.length };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const dreams = loadAllDreams();
  const visualStatus = await detectArtemisVisualStatus();

  // ── Status mode ───────────────────────────────────────────────────────────
  if (FLAG_STATUS) {
    if (!state) { console.log('[phosphene-dream] No state file found.'); return; }
    const evo  = state.evolution ?? {};
    const last = (evo.sessionHistory ?? [])[0];
    const todayKey = localDayKey();
    const todayDreamCount = countDreamsForDay(dreams, todayKey);
    const sleepReference = resolveSleepReference(state);
    console.log('[phosphene-dream] Status');
    console.log(`  State file:   ${STATE_PATH}`);
    console.log(`  Dreams dir:   ${DREAMS_DIR}`);
    console.log(`  Last session: ${last?.closedAt ?? 'none'}`);
    console.log(`  Last activity:${state.lastActivityAt ?? 'none'}`);
    console.log(`  Sleep from:   ${sleepReference.at ? `${sleepReference.label} @ ${sleepReference.at}` : 'none'}`);
    console.log(`  Last dream:   ${state.lastDreamAt ?? 'never'}`);
    console.log(`  Today:        ${todayKey} (${todayDreamCount}/${DAILY_MAX_DREAMS} dreams)`);
    const check = shouldDream(state, dreams);
    console.log(`  Dream check:  ${check.can ? '✓ would dream now' : `✗ ${check.reason}`}`);
    console.log(`  Visual model: ${visualStatus.available ? '✓ Artemis configured' : `✗ ${visualStatus.reason}`}`);
    console.log(`  Total dreams: ${dreams.length}`);
    return;
  }

  // ── Gallery rebuild only ──────────────────────────────────────────────────
  if (FLAG_GALLERY) {
    const { out, count } = rebuildGallery();
    console.log(`[phosphene-dream] Gallery rebuilt — ${count} dreams → ${out}`);
    return;
  }

  // ── Dream check ───────────────────────────────────────────────────────────
  if (!state) {
    console.log('[phosphene-dream] No state file — nothing to dream about yet.');
    return;
  }

  if (!visualStatus.available) {
    if (!FLAG_QUIET) {
      console.log(`[phosphene-dream] Not starting: Artemis visual model is not configured (${visualStatus.reason}).`);
    }
    return;
  }

  const evo = state.evolution ?? {};
  const check = shouldDream(state, dreams);

  if (!FLAG_FORCE && !check.can) {
    if (!FLAG_QUIET) {
      console.log(`[phosphene-dream] Not dreaming: ${check.reason}`);
    }
    return;
  }

  const sleepReference = resolveSleepReference(state);
  const sleepHours = check.sleepHours ?? hoursSince(sleepReference.at);

  if (!FLAG_QUIET) {
    console.log(`[phosphene-dream] Entering dream state…`);
    console.log(`  Stage will be determined by context`);
    console.log(`  Sleep duration: ${sleepHours.toFixed(1)}h`);
    console.log(`  Daily cadence: ${(check.todayDreamCount ?? 0) + 1}/${DAILY_MAX_DREAMS} for ${check.todayKey ?? localDayKey()}`);
    if (check.forced) {
      console.log(`  Trigger: ${check.reason}`);
    } else if (typeof check.probability === 'number') {
      console.log(`  Trigger: random pass at ${(check.probability * 100).toFixed(0)}%`);
    }
  }

  // ── Generate dream ────────────────────────────────────────────────────────
  const dream = generateDream(state, sleepHours);
  if (!FLAG_QUIET) {
    console.log(`  Stage: ${dream.stage} · Fragments: ${dream.fragments.length}`);
  }

  // ── Generate images through Artemis ───────────────────────────────────────
  const dreamWithImages = await generateAndDownloadImages(dream);
  if (!dreamWithImages) return;

  // ── Write markdown ────────────────────────────────────────────────────────
  mkdirSync(DREAMS_DIR, { recursive: true });
  const mdPath = join(DREAMS_DIR, `${dream.id}.md`);
  writeFileSync(mdPath, renderDreamMarkdown(dreamWithImages), 'utf8');
  if (!FLAG_QUIET) {
    console.log(`  Saved: ${mdPath}`);
  }

  // ── Update state ──────────────────────────────────────────────────────────
  state.lastDreamAt = dream.dreamedAt;
  saveState(state);

  // ── Rebuild gallery ───────────────────────────────────────────────────────
  const { out: galleryPath, count } = rebuildGallery();
  if (!FLAG_QUIET) {
    console.log(`  Gallery: ${galleryPath} (${count} dreams total)`);
    console.log(`[phosphene-dream] ◎ Dream complete.`);
    process.stdout.write(
      `\n[phosphene] Dream recorded: ${dream.stage} stage · ` +
      `${dream.fragments.length} fragments · ` +
      `${Object.keys(dreamWithImages.imagePaths).length} images\n` +
      `Gallery: ${galleryPath}\n`
    );
  }
}

main().catch(err => {
  console.error('[phosphene-dream] Fatal error:', err.message);
  process.exit(1);
});
