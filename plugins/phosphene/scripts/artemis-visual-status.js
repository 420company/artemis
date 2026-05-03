#!/usr/bin/env node
/**
 * Phosphene — Artemis visual model gate
 *
 * Checks whether the host Artemis CLI has a configured visual/image provider.
 * Phosphene dreams are intentionally disabled when this check fails so the
 * plugin never asks users to configure duplicate API keys.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ARGS = process.argv.slice(2);
const FLAG_JSON = ARGS.includes('--json');
const ARTEMIS_HOME = process.env.ARTEMIS_HOME || join(homedir(), '.artemis');

const VISUAL_KEY_RE = /(^|[-_])(image|images|img|visual|vision|video|generate[_-]?image|generate[_-]?video)([-_]|$)/i;
const TEXT_ONLY_RE = /(^|[-_])(chat|text|embedding|embeddings|speech|tts|stt|audio|transcribe)([-_]|$)/i;
const SECRET_KEY_RE = /(api[_-]?key|apikey|token|secret|credential|access[_-]?key|auth)/i;
const MODEL_KEY_RE = /(model|engine|deployment)/i;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasCredentialSignal(value) {
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) && typeof nested === 'string' && nested.trim()) return true;
    if (/env/i.test(key) && typeof nested === 'string' && nested.trim()) return true;
    if (/baseUrl|endpoint|url/i.test(key) && typeof nested === 'string' && nested.trim()) return true;
    if (MODEL_KEY_RE.test(key) && typeof nested === 'string' && nested.trim()) return true;
  }
  return false;
}

function providerNameFromPath(path) {
  return path.split('.').filter(Boolean).reverse().find(part => !/^\d+$/.test(part) && !VISUAL_KEY_RE.test(part));
}

function readVisualProfile(value) {
  if (!isRecord(value)) return null;
  const profile = value.visualProfile;
  if (!isRecord(profile) || profile.enabled !== true) return null;
  const image = profile.image;
  if (!isRecord(image)) return null;
  if (typeof image.apiKey !== 'string' || !image.apiKey.trim()) return null;
  return {
    path: 'visualProfile.image',
    provider: typeof image.provider === 'string' && image.provider.trim() ? image.provider.trim() : undefined,
  };
}

function scan(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = scan(value[i], `${path}.${i}`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.enabled === false || value.disabled === true) return null;

  const entries = Object.entries(value);
  const pathLooksVisual = VISUAL_KEY_RE.test(path) && !TEXT_ONLY_RE.test(path);
  const typeLooksVisual = entries.some(([key, nested]) => /type|kind|capability|tool|modality|mode|name|id|provider/i.test(key) && typeof nested === 'string' && VISUAL_KEY_RE.test(nested) && !TEXT_ONLY_RE.test(nested));
  const modelLooksVisual = entries.some(([key, nested]) => MODEL_KEY_RE.test(key) && typeof nested === 'string' && (VISUAL_KEY_RE.test(nested) || /dall-e|gpt-image|imagen|flux|stable-diffusion|sdxl|midjourney|recraft|ideogram|kling|runway|veo/i.test(nested)));

  if ((pathLooksVisual || typeLooksVisual || modelLooksVisual) && hasCredentialSignal(value)) {
    return { path: path || '.', provider: providerNameFromPath(path) };
  }

  for (const [key, nested] of entries) {
    const hit = scan(nested, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

function detect() {
  const checkedFiles = [
    join(ARTEMIS_HOME, 'providers.json'),
    join(ARTEMIS_HOME, 'cli-settings.json'),
    join(ARTEMIS_HOME, 'config.json'),
  ];
  for (const file of checkedFiles) {
    if (!existsSync(file)) continue;
    const json = readJson(file);
    const hit = readVisualProfile(json) ?? scan(json);
    if (hit) return { available: true, artemisHome: ARTEMIS_HOME, checkedFiles, matchedPath: hit.path, matchedProvider: hit.provider, reason: `visual provider found in ${file}` };
  }
  return { available: false, artemisHome: ARTEMIS_HOME, checkedFiles, reason: 'no configured Artemis visual/image provider found' };
}

const status = detect();

if (FLAG_JSON) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log('[phosphene-artemis] Visual model gate');
  console.log(`  Artemis home: ${status.artemisHome}`);
  console.log(`  Visual model: ${status.available ? 'configured' : 'missing'}`);
  if (status.matchedPath) console.log(`  Match:        ${status.matchedPath}`);
  if (status.matchedProvider) console.log(`  Provider:     ${status.matchedProvider}`);
  console.log(`  Reason:       ${status.reason}`);
  if (!status.available) {
    console.log('  Dreams:       disabled until Artemis has a visual/image provider configured');
  }
}

process.exit(status.available ? 0 : 2);
