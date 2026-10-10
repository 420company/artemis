// `artemis dream`: headless, one dream per call, a machine-readable result line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// The dream store resolves its root when first imported: point it at a scratch home first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-dream-cmd-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.ARTEMIS_HOME = home;
delete process.env.ARTEMIS_DREAMS_ROOT;

const { parseArgs, getHelpText } = await import('../src/cli/parseArgs.js');
const { parseDreamArgs, dreamWindow, splitDreamMarkdown, runDreamCommand, DREAM_RESULT_MARKER, DreamArgsError } = await import('../src/cli/dreamCommand.js');
const { findInternalNames } = await import('../src/utils/internalNames.js');
const { resolveDataRootDir } = await import('../src/utils/fs.js');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✔ ${name}`);
}

await test('dream is a CLI command; its flags reach the subcommand', () => {
  const parsed = parseArgs(['dream', '--json', '--out', '/tmp/x', '--no-image', '--cwd', root]);
  assert.equal(parsed.command, 'dream');
  assert.equal(parsed.cwd, root);
  assert.deepEqual(parsed.promptArgs, ['--json', '--out', '/tmp/x', '--no-image']);
  const help = getHelpText('zh-CN').split('\n').find((line) => /^\s+dream\b/.test(line)) ?? '';
  assert.match(help, /梦境/);
  assert.deepEqual(findInternalNames(help), [], 'the help line names nothing internal');
});

await test('dream options: defaults, flags and bad input', () => {
  assert.deepEqual(parseDreamArgs([]), { image: true, video: false, requireActivity: false, push: false, json: false });
  const o = parseDreamArgs(['--out=/tmp/d', '--no-image', '--video', '--date', '2026-10-09', '--require-activity', '--locale', 'zh', '--push', '--json']);
  assert.equal(o.outDir, path.resolve('/tmp/d'));
  assert.equal(o.image, false);
  assert.equal(o.video, true);
  assert.equal(o.date, '2026-10-09');
  assert.equal(o.requireActivity, true);
  assert.equal(o.locale, 'zh-CN');
  assert.equal(o.push, true);
  assert.equal(parseDreamArgs(['--locale', 'en-US']).locale, 'en');
  for (const bad of [['--date', '2026-02-30'], ['--date', 'yesterday'], ['--since-hours', '0'], ['--date', '2026-10-09', '--since-hours', '3'], ['--frobnicate'], ['--out'], ['--locale', 'fr']]) {
    assert.throws(() => parseDreamArgs(bad), DreamArgsError, bad.join(' '));
  }
});

await test('dream window: a local day, or the last n hours', () => {
  const now = new Date(2026, 9, 10, 23, 30);
  const day = dreamWindow({ date: '2026-10-09' }, now);
  assert.equal(day.day, '2026-10-09');
  assert.equal(day.sinceMs, new Date(2026, 9, 9).getTime());
  assert.equal(day.untilMs, new Date(2026, 9, 10).getTime() - 1);
  const last = dreamWindow({}, now);
  assert.equal(last.day, '2026-10-10');
  assert.equal(last.untilMs - last.sinceMs, 24 * 3_600_000);
  assert.equal(dreamWindow({ sinceHours: 6 }, now).untilMs - dreamWindow({ sinceHours: 6 }, now).sinceMs, 6 * 3_600_000);
});

await test('dream markdown: title and diary, without the header comment or the distilled notes', () => {
  const split = splitDreamMarkdown('<!-- dream id: x -->\n\n# 金属森林\n\n第一段。\n\n第二段。\n\n### 学到了什么\n- 简洁\n');
  assert.equal(split.title, '金属森林');
  assert.equal(split.diary, '第一段。\n\n第二段。');
  assert.equal(splitDreamMarkdown('# Key\n\nBody.\n\n### What I learned\n- x').diary, 'Body.');
});

// A model endpoint that writes the dream; it records what it was asked.
const asked: string[] = [];
let reply = '# 金属森林\n\n银色的钥匙穿过一座安静的桥，季度的数字在树梢上发光。\n\n### 学到了什么\n- 主人喜欢简洁的结论\n';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    asked.push(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  defaultMainProfileId: 'main',
  profiles: [{ id: 'main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'dream-model' }],
}));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const run = async (args: string[]) => {
  const lines: string[] = [];
  const statuses: string[] = [];
  const out = await runDreamCommand({ cwd: workspace, locale: 'en', args, write: (l) => lines.push(l), status: (l) => statuses.push(l) });
  assert.equal(lines.length, 1, 'exactly one result line');
  assert.ok(lines[0]!.startsWith(`${DREAM_RESULT_MARKER} `));
  const parsed = JSON.parse(lines[0]!.slice(DREAM_RESULT_MARKER.length + 1));
  assert.deepEqual(parsed, out.result);
  return { ...out, statuses, parsed };
};

try {
  await test('no activity in the window: skipped with --require-activity, and the model is never asked', async () => {
    const r = await run(['--require-activity', '--json']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.parsed.status, 'skipped');
    assert.equal(r.parsed.reason, 'no_activity');
    assert.equal(r.parsed.sessions, 0);
    assert.equal(asked.length, 0);
  });

  // The workspace's own engine session (where headless runs keep theirs) is the day's material.
  const sessions = path.join(resolveDataRootDir(workspace), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'a.json'), JSON.stringify({ title: 'report', cwd: workspace, messages: [{ role: 'user', content: '帮我整理季度报告' }] }));

  await test('a diary from the workspace sessions, copied into --out, with one result line', async () => {
    const out = path.join(workspace, 'dreams');
    const r = await run(['--require-activity', '--no-image', '--out', out, '--locale', 'zh-CN']);
    assert.equal(r.exitCode, 0, JSON.stringify(r.parsed));
    assert.equal(r.parsed.status, 'ok');
    assert.equal(r.parsed.title, '金属森林');
    assert.match(r.parsed.diary, /银色的钥匙/);
    assert.doesNotMatch(r.parsed.diary, /学到了什么/);
    assert.deepEqual(r.parsed.learned, ['主人喜欢简洁的结论']);
    assert.equal(r.parsed.locale, 'zh-CN');
    assert.equal(r.parsed.sessions, 1);
    assert.equal(r.parsed.imagePath, undefined);
    assert.equal(r.parsed.imageNote, undefined, 'no picture was asked for');
    assert.ok(r.parsed.diaryPath.startsWith(out + path.sep), r.parsed.diaryPath);
    assert.ok(fs.existsSync(r.parsed.diaryPath));
    assert.match(asked.at(-1)!, /帮我整理季度报告/, 'the workspace session reached the model');
    assert.ok(r.statuses.length > 0, 'progress goes to the status stream');
  });

  await test('a picture is asked for but no visual model is configured: the diary still comes, with a note', async () => {
    const r = await run(['--json']);
    assert.equal(r.parsed.status, 'ok');
    assert.equal(r.parsed.imagePath, undefined);
    assert.equal(typeof r.parsed.imageNote, 'string');
    assert.deepEqual(r.statuses, [], '--json prints only the result line');
  });

  await test('an empty model answer is a failure (exit 1), still with a result line', async () => {
    reply = '';
    const r = await run(['--json', '--no-image']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.parsed.status, 'failed');
    assert.ok(r.parsed.reason);
  });

  await test('bad arguments exit 2 without a result line', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (errors.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const r = await runDreamCommand({ cwd: workspace, locale: 'en', args: ['--date', 'soon'], write: (l) => lines.push(l) });
      assert.equal(r.exitCode, 2);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(lines, []);
    assert.match(errors.join(''), /--date/);
  });
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n  ✔ dream command smoke: ${passed} passed`);
