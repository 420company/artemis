/**
 * cli/skillLibraryCommand.ts — `artemis skills catalog|show|packs`: the
 * skill library (extensions/skillLibrary.ts) for hosts and scripts.
 *
 *   artemis skills catalog [--json]          every skill, packs included (enabled or not)
 *   artemis skills show <id> --json          one skill: its instructions and reference files
 *   artemis skills packs [--json]            the optional packs and their groups
 *   artemis skills packs enable <pack[/group]>
 *   artemis skills packs disable <pack[/group]>
 *   artemis skills curated [--audience <id>] [--json]
 *                                            the curated picks of the cco packs
 *
 * JSON goes to stdout (one document, `version: 1`); errors are
 * `{"error": {...}}` with exit code 1 (an unknown skill: 2). No file paths
 * of this machine are printed.
 *
 * The JSON is what a host shows its users, so the text in it names no AI
 * vendor, product or model and no internal system (utils/vendorNames.ts):
 * those names are replaced, skills and files named after one are left out,
 * and the skill-text guard walks the whole catalog for any left.
 */

import type { UiLocale } from './locale.js'
import {
  describeSource,
  findLibrarySkill,
  listSkillFiles,
  loadSkillLibrary,
  readLibrarySkillText,
  setPackGroup,
  type LibrarySkill,
  type PackInfo,
} from '../extensions/skillLibrary.js'
import { VENDOR_BODY_ALLOWLIST, namesVendor, scrubVendorNames } from '../utils/vendorNames.js'
import { listCuratedSkills } from '../extensions/curatedSkills.js'

/** What `show` returns of SKILL.md. */
const SHOW_MAX_CHARS = 40_000
/** What `catalog` returns of each description. */
const CATALOG_DESCRIPTION_MAX_CHARS = 400

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** A skill a host may list: its id and name name no vendor or internal system. */
function hostShows(skill: LibrarySkill): boolean {
  return !namesVendor(`${skill.id} ${skill.name}`)
}

const scrub = (text: string) => scrubVendorNames(text)
const scrubPair = (pair: { zh: string; en: string }) => ({ zh: scrub(pair.zh), en: scrub(pair.en) })

function entry(skill: LibrarySkill) {
  const tags = skill.tags.filter((tag) => !namesVendor(tag)).map(scrub)
  return {
    id: skill.id,
    name: scrub(skill.name),
    summary: scrub(skill.summary),
    description: clamp(scrub(skill.description), CATALOG_DESCRIPTION_MAX_CHARS),
    ...(skill.category ? { category: scrub(skill.category) } : {}),
    ...(tags.length ? { tags } : {}),
    source: skill.source,
    ...(skill.pack ? { pack: skill.pack.split('/')[0], audience: skill.pack.split('/')[1] } : {}),
    ...(skill.curated ? { curated: true } : {}),
    enabled: skill.enabled,
  }
}

function packEntry(pack: PackInfo) {
  return {
    id: pack.id,
    title: scrubPair(pack.title),
    description: scrubPair(pack.description),
    audiences: pack.audiences.map((audience) => ({ id: audience.id, title: scrubPair(audience.title), count: audience.count, enabled: audience.enabled })),
  }
}

export async function runSkillLibraryCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<number> {
  const { cwd, locale } = options
  const json = options.args.includes('--json')
  const args = options.args.filter((arg) => arg !== '--json')
  const sub = args[0]?.toLowerCase()
  const t = (zh: string, en: string) => (locale === 'zh-CN' ? zh : en)
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
  const error = (code: string, message: string, exit = 1): number => {
    if (json) out({ version: 1, error: { code, message } })
    else console.error(message)
    return exit
  }

  if (sub === 'catalog') {
    const library = await loadSkillLibrary(cwd, { allPacks: true })
    if (json) {
      out({ version: 1, skills: library.skills.filter(hostShows).map(entry), packs: library.packs.map(packEntry) })
      return 0
    }
    const enabled = library.skills.filter((skill) => skill.enabled)
    console.log(t(`技能库：${enabled.length} 个可用（共 ${library.skills.length} 个，含未启用的技能包）`, `Skill library: ${enabled.length} enabled (${library.skills.length} with packs that are off)`))
    for (const skill of enabled) console.log(`  ${skill.id.padEnd(36)} ${skill.summary}`)
    return 0
  }

  if (sub === 'show' || sub === 'read') {
    const id = args[1]
    if (!id) return error('usage', 'Usage: artemis skills show <id> --json')
    const library = await loadSkillLibrary(cwd, { allPacks: true })
    const skill = findLibrarySkill(library, id)
    if (!skill) return error('not_found', `No skill "${id}"`, 2)
    if (json && !hostShows(skill)) return error('not_found', `No skill "${id}"`, 2)
    const [{ text, truncated }, files] = await Promise.all([readLibrarySkillText(skill, SHOW_MAX_CHARS), listSkillFiles(skill)])
    // Developer skills about wiring an app to model APIs keep the vendors' names in their instructions (only there).
    const keepVendors = VENDOR_BODY_ALLOWLIST.has(skill.id)
    out({
      version: 1,
      skill: {
        ...entry(skill),
        description: scrub(skill.description),
        origin: describeSource(skill),
        content: scrubVendorNames(text, { keepVendors }),
        truncated,
        files: files.filter((file) => keepVendors || !namesVendor(file)),
      },
    })
    return 0
  }

  if (sub === 'curated') {
    let audience: string | undefined
    const rest = args.slice(1)
    const at = rest.indexOf('--audience')
    if (at >= 0) {
      audience = rest[at + 1]?.toLowerCase()
      rest.splice(at, 2)
    }
    if (rest.length || (at >= 0 && !audience)) return error('usage', 'Usage: artemis skills curated [--audience <id>] [--json]')
    const library = await loadSkillLibrary(cwd, { allPacks: true })
    const knownAudience = !audience || library.packs.some((pack) => pack.audiences.some((a) => a.id === audience))
    if (!knownAudience) return error('not_found', `No audience "${audience}"`)
    const picks = listCuratedSkills(library, audience)
    if (json) {
      out({ version: 1, audience: audience ?? null, skills: picks.filter(hostShows).map(entry) })
      return 0
    }
    console.log(
      t(
        `精选技能：${picks.length} 个${audience ? `（${audience}）` : '（8 个人群）'}，★ 为优先推荐`,
        `Curated skills: ${picks.length}${audience ? ` (${audience})` : ' (8 audiences)'}; ★ marks the recommended picks`,
      ),
    )
    for (const skill of picks) console.log(`  ★ ${skill.id.padEnd(36)} ${skill.summary}`)
    return 0
  }

  if (sub === 'packs') {
    const action = args[1]?.toLowerCase()
    if (action === 'enable' || action === 'disable') {
      const name = args[2]
      if (!name) return error('usage', `Usage: artemis skills packs ${action} <pack[/group]>`)
      const library = await loadSkillLibrary(cwd)
      const [packId, group] = name.toLowerCase().split('/')
      const pack = library.packs.find((p) => p.id === packId)
      if (!pack || (group && !pack.audiences.some((a) => a.id === group))) return error('not_found', `No skill pack "${name}"`, 2)
      let enabled: string[]
      try {
        enabled = await setPackGroup(name, action === 'enable')
      } catch (err) {
        return error('failed', err instanceof Error ? err.message : String(err))
      }
      if (json) out({ version: 1, enabled })
      else console.log(t(`已${action === 'enable' ? '启用' : '停用'}：${name}`, `${action === 'enable' ? 'Enabled' : 'Disabled'}: ${name}`))
      return 0
    }
    const library = await loadSkillLibrary(cwd)
    if (json) {
      out({ version: 1, packs: library.packs.map(packEntry) })
      return 0
    }
    for (const pack of library.packs) {
      console.log(`${pack.id}  ${t(pack.title.zh, pack.title.en)}`)
      for (const audience of pack.audiences) console.log(`  ${`${pack.id}/${audience.id}`.padEnd(24)} ${String(audience.count).padStart(4)}  ${audience.enabled ? t('已启用', 'on') : t('未启用', 'off')}  ${t(audience.title.zh, audience.title.en)}`)
    }
    return 0
  }

  return error('usage', 'Usage: artemis skills catalog|show <id>|packs|curated [--json]')
}
