// The skill text hosts show their users (`artemis skills catalog --json`,
// `artemis skills show <id> --json`, every skill and pack): no AI vendor,
// product or model name (utils/vendorNames.ts) and no internal system name
// is left, outside the instructions of the few allowlisted developer skills.
// Also checks the scrub itself on the sentences reviewers found.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HOST_INTERNAL_NAMES, VENDOR_BODY_ALLOWLIST, VENDOR_NAMES, scrubVendorNames } from '../src/utils/vendorNames.js'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-skill-text-'))
process.env.ARTEMIS_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.ARTEMIS_HOME, { recursive: true })
delete process.env.ARTEMIS_SKILL_PACKS
const cwd = path.join(sandbox, 'ws')
fs.mkdirSync(cwd, { recursive: true })

const { runSkillLibraryCommand } = await import('../src/cli/skillLibraryCommand.js')

async function run(args: string[]): Promise<any> {
  const out: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write
  try {
    await runSkillLibraryCommand({ cwd, locale: 'en', args })
  } finally {
    process.stdout.write = write
  }
  return JSON.parse(out.join(''))
}

console.log('skill text for hosts')

// The scrub on what reviewers found.
const cases: Array<[string, string]> = [
  ['Mid (Sonnet, GPT-4o) and Large (Opus, o3); Small (Haiku)', 'Mid (a model, a model) and Large (a model, a model); Small (a model)'],
  ['1. Use a Haiku agent to check the PR', '1. Use a model agent to check the PR'],
  ['| Claude 3 Opus | fast |', '| a model | fast |'],
  ['DALL-E is outdated; GPT models and Whisper API', 'an image model is outdated; AI models and speech recognition API'],
  ['drag the .mcpb file onto Claude Desktop', 'drag the .mcpb file onto a desktop AI app'],
  ['If `.claude/product-marketing-context.md` exists, read it', 'If `product-marketing-context.md` exists, read it'],
  ['cp -r engineering/agenthub ~/.claude/skills/agenthub', 'cp -r engineering/agenthub ~/skills/agenthub'],
  ['Generated with [Claude Code](https://claude.ai/code)', 'Generated with the agent'],
  ['the saga pattern', 'the … pattern'],
  // "Opus" next to other codecs is the audio codec, and stays.
  ['Codecs: PCM, G.711, Opus and AAC', 'Codecs: PCM, G.711, Opus and AAC'],
  ['encode with the Opus codec at 48 kHz', 'encode with the Opus codec at 48 kHz'],
  ['Opus / MP3 / WAV output', 'Opus / MP3 / WAV output'],
  ['Large (Opus 4, GPT-4o) for long context', 'Large (a model, a model) for long context'],
]
for (const [input, expected] of cases) assert.equal(scrubVendorNames(input), expected)
for (const [, expected] of cases) assert.ok(!VENDOR_NAMES.test(expected), expected)
assert.ok(VENDOR_NAMES.test('ask Opus to review it') && VENDOR_NAMES.test('model: opus'), 'Opus outside a codec list is still the model')
console.log(`  ✔ the scrub reads naturally (${cases.length} cases)`)

const started = Date.now()
const catalog = await run(['catalog', '--json'])
assert.equal(catalog.version, 1)
assert.ok(catalog.skills.length > 800, `${catalog.skills.length} skills`)
const offenders: string[] = []
const check = (where: string, text: string) => {
  for (const re of [VENDOR_NAMES, HOST_INTERNAL_NAMES]) {
    const hit = re.exec(text)
    if (hit) offenders.push(`${where}: …${text.slice(Math.max(0, hit.index - 30), hit.index + 30).replace(/\s+/g, ' ')}…`)
  }
}
check('packs', JSON.stringify(catalog.packs))
for (const skill of catalog.skills) {
  check(skill.id, JSON.stringify(skill))
  const shown = await run(['show', skill.id, '--json'])
  assert.ok(shown.skill, `${skill.id}: ${JSON.stringify(shown).slice(0, 200)}`)
  const { content, ...rest } = shown.skill
  check(`${skill.id} (show)`, JSON.stringify(rest))
  if (!VENDOR_BODY_ALLOWLIST.has(skill.id)) check(`${skill.id} content`, String(content))
}
assert.deepEqual(offenders.slice(0, 20), [], `${offenders.length} places name a vendor or an internal system`)
console.log(`  ✔ ${catalog.skills.length} skills and ${catalog.packs.length} pack(s): no vendor, product, model or internal name (${Date.now() - started} ms)`)
fs.rmSync(sandbox, { recursive: true, force: true })
console.log('skill text: 2 passed')
