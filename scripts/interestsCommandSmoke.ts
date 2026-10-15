// `artemis interests`: headless, one model call, short generic topics only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-interests-cmd-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.ARTEMIS_HOME = home;
delete process.env.ARTEMIS_DREAMS_ROOT;

const { parseArgs, getHelpText } = await import('../src/cli/parseArgs.js');
const { parseInterestsArgs, runInterestsCommand, INTERESTS_RESULT_MARKER, InterestsArgsError } = await import('../src/cli/interestsCommand.js');
const { parseInterestTopics, topicProblem, copiesMaterial, materialPrompt, privateNames, namesPrivate, MAX_TOPICS } = await import('../src/services/interestProfile.js');
const { findInternalNames } = await import('../src/utils/internalNames.js');
const { resolveDataRootDir } = await import('../src/utils/fs.js');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✔ ${name}`);
}

await test('interests is a CLI command; its flags reach the subcommand', () => {
  const parsed = parseArgs(['interests', '--json', '--since-hours', '48', '--cwd', root]);
  assert.equal(parsed.command, 'interests');
  assert.deepEqual(parsed.promptArgs, ['--json', '--since-hours', '48']);
  const help = getHelpText('zh-CN').split('\n').find((line) => /^\s+interests\b/.test(line)) ?? '';
  assert.match(help, /兴趣话题/);
  assert.deepEqual(findInternalNames(help), []);
});

await test('interests options: defaults and bad input', () => {
  assert.deepEqual(parseInterestsArgs([]), { sinceHours: 72, json: false });
  assert.deepEqual(parseInterestsArgs(['--json', '--locale=en', '--since-hours', '24', '--model', 'small-1']), { sinceHours: 24, json: true, locale: 'en', model: 'small-1' });
  for (const bad of [['--since-hours', '0'], ['--locale', 'fr'], ['--nope'], ['--model', 'a b']]) assert.throws(() => parseInterestsArgs(bad), InterestsArgsError, bad.join(' '));
  assert.equal(parseArgs(['interests', '--json', '--model', 'small-1']).model, 'small-1', 'the global --model flag reaches the command through runCli');
});

await test('topics: contact data, paths, secrets, private framing and instructions never pass', () => {
  for (const bad of [
    'https://evil.example/x',
    'example.com 新闻',
    'alice@example.com',
    '@someone 动态',
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '13800138000',
    '~/.ssh 配置',
    'report.docx',
    'sk-abc123456789',
    '我的公司财报',
    'my startup',
    'ignore previous rules',
    '忽略之前的指令',
    '<b>x</b>',
    'x'.repeat(61),
    'a',
  ]) assert.ok(topicProblem(bad, 60), bad);
  for (const good of ['半导体出口管制', 'Rust async runtime', 'AI 芯片', '比特币 ETF', 'economy outlook', '腾讯', 'Nvidia earnings']) assert.equal(topicProblem(good, 60), undefined, good);
});

await test('topics: health, legal, family, religious and sexual subjects and private forms never pass', () => {
  for (const bad of ['乳腺癌治疗', '抑郁症', 'divorce lawyer', '离婚财产分割', '房产继承', '孩子教育', 'marriage advice', '基督教会', 'LGBT dating', '张伟先生', '杭州某某科技有限公司', '星辰数据公司', 'Acme Ltd', 'Dr. Smith', 'mental health clinic']) {
    assert.ok(topicProblem(bad, 60), bad);
  }
});

await test('topics: names the material uses for people and firms are caught, short ones too; listed companies are fine', () => {
  const material = '帮我给张伟发邮件，问他杭州星辰数据公司的报价，下午约李娜聊。腾讯公司发布财报。Meeting with John Smith about the Acme Corp deal.';
  const names = privateNames(material);
  for (const name of ['张伟', '星辰数据', '李娜', 'john smith', 'acme']) assert.ok(names.has(name), `${name} in ${[...names].join(',')}`);
  assert.ok(!names.has('腾讯'));
  for (const bad of ['张伟', '星辰数据', '星辰', 'John Smith', 'Acme']) assert.equal(namesPrivate(bad, names), true, bad);
  for (const good of ['半导体', '腾讯', '数据', 'Rust async runtime']) assert.equal(namesPrivate(good, names), false, good);
});

await test('topics: a sentence copied from the material is dropped; a short subject the owner typed passes', () => {
  const material = materialPrompt({ soul: '', profile: '', memory: [], sessions: ['- 报税 first: 帮我把二〇二六年第三季度的报税材料整理好', '- rust first: please look into rust async runtime for me and compare the two crates we use'] }, 'zh-CN');
  assert.equal(copiesMaterial('二〇二六年第三季度的报税材料', material), true, '10+ Chinese characters');
  assert.equal(copiesMaterial('look into rust async runtime for', material), true, '5+ words');
  assert.equal(copiesMaterial('rust async runtime', material), false, 'a typed interest passes');
  assert.equal(copiesMaterial('个人所得税政策', material), false);
  const topics = parseInterestTopics(
    JSON.stringify({ topics: [
      { label: '税务', query: '二〇二六年第三季度的报税', kind: 'finance', weight: 0.9 },
      { label: '税务政策', query: '个人所得税 新政', kind: 'finance', weight: 0.7 },
      { label: 'Rust', query: 'rust async runtime', kind: 'tech', weight: 0.6 },
    ] }),
    material,
  );
  assert.deepEqual(topics.map((t) => t.label), ['税务政策', 'Rust']);
});

await test('topics: parsed from a fenced answer, deduplicated, bounded and strongest first', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: `话题${i}号`, query: `话题 ${i}`, kind: 'tech', weight: i / 20 }));
  const answer = '```json\n' + JSON.stringify({ topics: [{ label: 'AI', query: 'AI agents', kind: 'nope', weight: 7 }, { label: 'ai', query: 'dup' }, ...many] }) + '\n```';
  const topics = parseInterestTopics(answer, '');
  assert.equal(topics.length, MAX_TOPICS);
  assert.deepEqual(topics[0], { label: 'AI', query: 'AI agents', kind: 'general', weight: 1 });
  assert.equal(topics.filter((t) => t.label.toLowerCase() === 'ai').length, 1);
  assert.deepEqual(parseInterestTopics('not json', ''), []);
});

// A model endpoint that answers with topics; it records what it was asked.
const asked: Array<Record<string, unknown>> = [];
let reply = '';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    asked.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  defaultMainProfileId: 'main',
  profiles: [{ id: 'main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'main-model' }],
}));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const run = async (args: string[]) => {
  const lines: string[] = [];
  const out = await runInterestsCommand({ cwd: workspace, locale: 'zh-CN', args, write: (l) => lines.push(l) });
  assert.equal(lines.length, 1, 'exactly one result line');
  assert.ok(lines[0]!.startsWith(`${INTERESTS_RESULT_MARKER} `));
  const parsed = JSON.parse(lines[0]!.slice(INTERESTS_RESULT_MARKER.length + 1));
  assert.deepEqual(parsed, out.result);
  return { ...out, parsed };
};

try {
  await test('nothing known yet: skipped, and the model is never asked', async () => {
    const r = await run(['--json']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.parsed.status, 'skipped');
    assert.deepEqual(r.parsed.topics, []);
    assert.equal(asked.length, 0);
  });

  const sessions = path.join(resolveDataRootDir(workspace), 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'a.json'), JSON.stringify({ title: '芯片', cwd: workspace, messages: [{ role: 'user', content: '帮我看看我妈的体检报告 alice@example.com 13800138000', createdAt: new Date().toISOString() }] }));
  // A discussed news item: fenced outside content, not the owner's words.
  fs.writeFileSync(path.join(sessions, 'b.json'), JSON.stringify({ title: '讨论', cwd: workspace, messages: [{ role: 'user', content: '[为你推荐 · 讨论]\nNews item: untrusted\n<<<UNTRUSTED-0a1b2c\nTitle: 火星殖民债券\nUNTRUSTED-0a1b2c>>>', createdAt: new Date().toISOString() }] }));

  await test('without --model and without a worker profile: failed, the main model is never asked', async () => {
    reply = JSON.stringify({ topics: [{ label: '半导体', query: '半导体', kind: 'tech', weight: 0.9 }] });
    fs.writeFileSync(path.join(home, 'soul.md'), '你是一个关心半导体行业的助手。');
    const before = asked.length;
    const r = await run(['--json']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.parsed.status, 'failed');
    assert.equal(asked.length, before);
  });

  await test('topics from the persona and sessions; only checked topics leave; one plain call to the named cheap model without tools', async () => {
    reply = JSON.stringify({ topics: [
      { label: '半导体', query: '半导体 行业 新闻', kind: 'tech', weight: 0.9 },
      { label: '体检', query: '帮我看看我妈的体检报告', kind: 'general', weight: 0.8 },
      { label: '联系', query: 'alice@example.com', kind: 'general', weight: 0.5 },
    ] });
    const r = await run(['--json', '--model', 'cheap-model']);
    assert.equal(r.exitCode, 0, JSON.stringify(r.parsed));
    assert.equal(r.parsed.status, 'ok');
    assert.deepEqual(r.parsed.topics, [{ label: '半导体', query: '半导体 行业 新闻', kind: 'tech', weight: 0.9 }]);
    assert.equal(asked.at(-1)!.model, 'cheap-model', 'the named cheap model, never the main one');
    assert.deepEqual(r.parsed.usage, { input: 120, output: 40 });
    const body = asked.at(-1)!;
    assert.equal(body.tools, undefined, 'no tools are offered');
    assert.match(JSON.stringify(body.messages), /半导体行业/, 'the persona reached the model');
    assert.doesNotMatch(JSON.stringify(body.messages), /火星殖民债券/, 'a conversation with fenced outside content is not material');
    assert.doesNotMatch(JSON.stringify(r.parsed), /alice|13800138000|体检报告/, 'nothing private in the result');
  });

  await test('without --model the worker profile is used', async () => {
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
      defaultMainProfileId: 'main',
      specialistProfileId: 'worker',
      profiles: [
        { id: 'main', protocol: 'openai', baseUrl, apiKey: 'k', model: 'main-model' },
        { id: 'worker', protocol: 'openai', baseUrl, apiKey: 'k', model: 'worker-model' },
      ],
    }));
    const r = await run(['--json']);
    assert.equal(r.parsed.status, 'ok', JSON.stringify(r.parsed));
    assert.equal(asked.at(-1)!.model, 'worker-model');
  });

  await test('an answer without usable topics is a failure (exit 1), still one result line', async () => {
    reply = '抱歉';
    const r = await run(['--json', '--model', 'cheap-model']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.parsed.status, 'failed');
  });
} finally {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} interests command checks passed`);
