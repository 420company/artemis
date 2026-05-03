import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { homedir } from 'os';
const KEYWORD_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'there', 'into', 'then', 'they', 'their',
    'what', 'when', 'while', 'have', 'been', 'still', 'only', 'very', 'than', 'which', 'through',
    'before', 'after', 'inside', 'outside', 'thing', 'things', 'same', 'again', 'version', 'without',
    'because', 'where', 'would', 'could', 'should', 'about', 'session', 'dream', 'artemis', 'phosphene',
    '一个', '这个', '那个', '我们', '你们', '他们', '不是', '但是', '然后', '因为', '所以', '如果',
    '需要', '系统', '梦境', '插件', '幻觉', '生成', '测试', '用户', '使用', '现在', '可以', '正常',
]);
function pushSource(target, term, score, source) {
    const normalized = term.trim().toLowerCase();
    if (!normalized || normalized.length < 2 || KEYWORD_STOPWORDS.has(normalized) || /^\d+$/.test(normalized))
        return;
    const existing = target.get(normalized);
    if (existing) {
        existing.score += score;
        if (!existing.sources.includes(source))
            existing.sources.push(source);
        return;
    }
    target.set(normalized, { term: term.trim(), score, sources: [source] });
}
function extractTerms(text) {
    const latin = text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .match(/[a-z][a-z0-9-]{3,}/g) ?? [];
    const chinese = text.match(/[\u4e00-\u9fff]{2,6}/g) ?? [];
    return [...latin, ...chinese];
}
function collectSessionTexts(evolution) {
    const rows = [];
    const sessions = [
        ...(evolution.currentSession ? [evolution.currentSession] : []),
        ...evolution.sessionHistory.slice(0, 5),
    ];
    for (const session of sessions) {
        for (const item of session.crystallized ?? [])
            rows.push({ text: item, source: `session:${session.id}:crystallized`, score: 2.4 });
        for (const item of session.anchored ?? [])
            rows.push({ text: item, source: `session:${session.id}:anchored`, score: 2.2 });
        for (const signal of session.signals ?? []) {
            if (signal.note)
                rows.push({ text: signal.note, source: `session:${session.id}:signal:${signal.type}`, score: signal.type === 'calibrate' ? 1.8 : 1.4 });
            if (signal.layer)
                rows.push({ text: signal.layer, source: `session:${session.id}:layer`, score: 0.8 });
            if (signal.voice)
                rows.push({ text: signal.voice, source: `session:${session.id}:voice`, score: 0.8 });
        }
    }
    for (const insight of evolution.crystallizedInsights.slice(-8))
        rows.push({ text: insight, source: 'evolution:crystallized', score: 2.0 });
    for (const signal of evolution.feedbackHistory.slice(-12)) {
        if (signal.note)
            rows.push({ text: signal.note, source: `feedback:${signal.type}`, score: 1.2 });
    }
    for (const point of evolution.optimalPoints.slice(-5)) {
        if (point.context)
            rows.push({ text: point.context, source: 'optimal-point', score: 1.6 });
    }
    return rows;
}
export function extractDynamicSessionKeywords(evolution, limit = 8) {
    const ranked = new Map();
    for (const row of collectSessionTexts(evolution)) {
        for (const term of extractTerms(row.text))
            pushSource(ranked, term, row.score, row.source);
    }
    return Array.from(ranked.values())
        .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
        .slice(0, limit)
        .map(item => ({ ...item, score: Math.round(item.score * 100) / 100 }));
}
export function buildHallucinationVisualPrompt(keywords, mode = 'image') {
    if (keywords.length === 0) {
        throw new Error('No dynamic session keywords found; hallucination visual tests require session-derived material.');
    }
    const terms = keywords.map(keyword => keyword.term).slice(0, 6);
    const base = [
        'Phosphene hallucination overlay, not the primary Artemis dream',
        'dream afterimage generated from live session residue',
        `session keywords: ${terms.join(', ')}`,
        'surreal perceptual upgrade, synesthetic distortion, tactile light, threshold architecture',
        'avoid literal dream journal, avoid duplicating Artemis memory, transform keywords into visual residues',
        'cinematic environmental scene, no centered portrait, no text labels, no watermark',
    ];
    if (mode === 'video') {
        base.push('slow camera drift, subtle breathing motion, fog-like temporal smear, 6 second seamless hallucination loop');
    }
    return {
        keywords,
        prompt: base.join(', '),
        negativePrompt: 'primary Artemis dream, memory archive screenshot, readable text, logo, watermark, generic fantasy, centered face, low quality, blurry',
        mode,
    };
}
export function resolveImageConfigFromEnv(env = process.env) {
    return {
        outputDir: env.ARTEMIS_IMAGE_OUTPUT_DIR ?? env.PHOSPHENE_IMAGE_OUTPUT_DIR,
        outputPath: env.ARTEMIS_IMAGE_OUTPUT_PATH ?? env.PHOSPHENE_IMAGE_OUTPUT_PATH,
        width: env.ARTEMIS_IMAGE_WIDTH ? Number(env.ARTEMIS_IMAGE_WIDTH) : undefined,
        height: env.ARTEMIS_IMAGE_HEIGHT ? Number(env.ARTEMIS_IMAGE_HEIGHT) : undefined,
    };
}
export function resolveVideoConfigFromEnv(env = process.env) {
    return {
        outputDir: env.ARTEMIS_VIDEO_OUTPUT_DIR ?? env.PHOSPHENE_VIDEO_OUTPUT_DIR,
        outputPath: env.ARTEMIS_VIDEO_OUTPUT_PATH ?? env.PHOSPHENE_VIDEO_OUTPUT_PATH,
        width: env.ARTEMIS_VIDEO_WIDTH ? Number(env.ARTEMIS_VIDEO_WIDTH) : undefined,
        height: env.ARTEMIS_VIDEO_HEIGHT ? Number(env.ARTEMIS_VIDEO_HEIGHT) : undefined,
        durationSeconds: env.ARTEMIS_VIDEO_SECONDS ? Number(env.ARTEMIS_VIDEO_SECONDS) : (env.PHOSPHENE_VIDEO_SECONDS ? Number(env.PHOSPHENE_VIDEO_SECONDS) : 6),
        dryRun: env.PHOSPHENE_VIDEO_DRY_RUN === 'true',
    };
}
function runArtemisTool(tool, args) {
    const cliArgs = ['tool', tool];
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== '')
            cliArgs.push(`${key}=${String(value)}`);
    }
    return new Promise((resolve, reject) => {
        const child = spawn('artemis', cliArgs, {
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
            const output = [stdout, stderr].filter(Boolean).join('\n');
            if (code === 0 && !/Invalid arguments|Tool not found|Error:/i.test(output)) {
                resolve(output.trim());
                return;
            }
            reject(new Error(output.trim() || `artemis tool ${tool} exited with code ${code}`));
        });
    });
}
function extractGeneratedPath(stdout, fallback) {
    const matches = [...stdout.matchAll(/:\s*(\/[^\n]+)$/gm)];
    return matches.at(-1)?.[1]?.trim() ?? fallback;
}
export async function runHallucinationImageTest(evolution, config = resolveImageConfigFromEnv(), outputDir = join(homedir(), 'phosphene-generated', 'hallucination', 'images')) {
    const keywords = extractDynamicSessionKeywords(evolution);
    const visualPrompt = buildHallucinationVisualPrompt(keywords, 'image');
    const resolvedOutputDir = config.outputDir ?? outputDir;
    mkdirSync(resolvedOutputDir, { recursive: true });
    const outputPath = config.outputPath ?? join(resolvedOutputDir, `hallucination-image-${Date.now()}.png`);
    const stdout = await runArtemisTool('generate_image', {
        prompt: `${visualPrompt.prompt}, hallucination overlay, chromatic afterimage, editorial surrealism, high-detail environmental composition`,
        outputPath,
        width: config.width,
        height: config.height,
    });
    return {
        ok: true,
        prompt: visualPrompt,
        image: {
            path: extractGeneratedPath(stdout, outputPath),
            backend: 'artemis',
            tool: 'generate_image',
            prompt: visualPrompt.prompt,
            stdout,
        },
    };
}
export async function runHallucinationVideoTest(evolution, config = resolveVideoConfigFromEnv()) {
    const keywords = extractDynamicSessionKeywords(evolution);
    const visualPrompt = buildHallucinationVisualPrompt(keywords, 'video');
    const outputDir = config.outputDir ?? join(homedir(), 'phosphene-generated', 'hallucination', 'video');
    mkdirSync(outputDir, { recursive: true });
    const metadata = {
        system: 'phosphene-hallucination-overlay',
        relationship_to_artemis: 'afterimage_not_primary_dream',
        dynamic_keywords: keywords,
    };
    if (config.dryRun) {
        const responsePath = join(outputDir, `hallucination-video-request-${Date.now()}.json`);
        writeFileSync(responsePath, JSON.stringify({ prompt: visualPrompt.prompt, negative_prompt: visualPrompt.negativePrompt, metadata }, null, 2), 'utf8');
        return { ok: true, prompt: visualPrompt, provider: 'artemis', dryRun: true, responsePath };
    }
    const outputPath = config.outputPath ?? join(outputDir, `hallucination-video-${Date.now()}.mp4`);
    const stdout = await runArtemisTool('generate_video', {
        prompt: `${visualPrompt.prompt}, ${visualPrompt.negativePrompt ? `avoid: ${visualPrompt.negativePrompt}` : ''}`,
        outputPath,
        width: config.width,
        height: config.height,
        duration: config.durationSeconds,
    });
    return {
        ok: true,
        prompt: visualPrompt,
        provider: 'artemis',
        dryRun: false,
        video: {
            path: extractGeneratedPath(stdout, outputPath),
            backend: 'artemis',
            tool: 'generate_video',
            prompt: visualPrompt.prompt,
            stdout,
        },
    };
}
export function loadEvolutionStateFromWorkspace(cwd = process.cwd()) {
    const statePath = join(cwd, '.artemis', 'phosphene-state.json');
    if (!existsSync(statePath)) {
        throw new Error(`Missing state file: ${statePath}. Run the plugin bootstrap first or pass a fixture state.`);
    }
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!parsed.evolution)
        throw new Error(`State file does not contain evolution: ${statePath}`);
    return parsed.evolution;
}
//# sourceMappingURL=hallucination-visual-test.js.map