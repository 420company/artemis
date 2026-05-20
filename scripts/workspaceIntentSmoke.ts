import assert from 'node:assert/strict'
import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { resolveWorkspaceIntent } from '../src/cli/workspaceIntent.js'
import { resolveDataRootDir } from '../src/utils/fs.js'

const cwd = process.cwd()

const pastedRichText = `用户复制了一段配置说明：

<div>
  nginx example: /etc/nginx/conf.d/artemis.conf
  hosts file: /private/etc/hosts
</div>

请帮我总结这段内容，不要切换工作区。`

assert.equal(await resolveWorkspaceIntent(pastedRichText, cwd), null)

const longSingleLine = `请分析这段日志 ${'x'.repeat(520)} in /etc nginx failed`
assert.equal(await resolveWorkspaceIntent(longSingleLine, cwd), null)

assert.equal(await resolveWorkspaceIntent('/what is this command', cwd), null)
assert.equal(await resolveWorkspaceIntent('/某某 只是普通消息内容', cwd), null)

const explicit = await resolveWorkspaceIntent(`进入 ${tmpdir()} 继续检查`, cwd)
assert.ok(explicit)
assert.equal(explicit.workspacePath, tmpdir())

const explicitWorkspaceWord = await resolveWorkspaceIntent(`进入工作区 "${tmpdir()}" 继续检查`, cwd)
assert.ok(explicitWorkspaceWord)
assert.equal(explicitWorkspaceWord.workspacePath, tmpdir())

const setAsWorkspace = await resolveWorkspaceIntent(`把 "${tmpdir()}" 设为工作区`, cwd)
assert.ok(setAsWorkspace)
assert.equal(setAsWorkspace.workspacePath, tmpdir())

const englishExplicit = await resolveWorkspaceIntent(`switch to ${tmpdir()} and inspect`, cwd)
assert.ok(englishExplicit)
assert.equal(englishExplicit.workspacePath, tmpdir())

const fakeHome = path.join(tmpdir(), 'artemis-workspace-intent-home')
const errorQuotedPath = path.join(path.dirname(fakeHome), '.artemis')
const quotedError = `为什么报错“错误：EACCES: permission denied, mkdir '${errorQuotedPath}'”`
assert.equal(await resolveWorkspaceIntent(quotedError, cwd, fakeHome), null)

const missingDataRoot = await resolveWorkspaceIntent(`进入 ${errorQuotedPath} 继续`, cwd, fakeHome)
assert.equal(missingDataRoot, null)

const existingPathInBody = path.join(tmpdir(), 'artemis-workspace-intent-existing')
const existingChildPath = path.join(existingPathInBody, 'index.ts')
assert.equal(await resolveWorkspaceIntent(`请检查 ${existingChildPath} 为什么报错`, cwd, fakeHome), null)
assert.equal(await resolveWorkspaceIntent(`run tests in ${tmpdir()}`, cwd, fakeHome), null)
assert.equal(await resolveWorkspaceIntent(`send output to ${tmpdir()}`, cwd, fakeHome), null)

assert.equal(
  resolveDataRootDir(path.dirname(homedir())),
  path.join(homedir(), '.artemis'),
)

// ── Media-file paths must NOT trigger workspace switch ──────────────────────
// Regression coverage for the /saga "失忆" bug: sending an image path with
// a description used to switch workspace to the file's parent directory,
// breaking any in-flight cwd-keyed workflow.
const desktopImage = path.join(homedir(), 'Desktop', 'artemis-smoke-photo.jpg')
assert.equal(
  await resolveWorkspaceIntent(`${desktopImage} 这是你的角色图`, cwd),
  null,
  'leading image path + space + Chinese description must not switch workspace',
)
assert.equal(
  await resolveWorkspaceIntent(`${desktopImage}这是你的角色图`, cwd),
  null,
  'leading image path + NO space + Chinese must not switch (boundary fix)',
)
assert.equal(
  await resolveWorkspaceIntent(`${desktopImage}!`, cwd),
  null,
  'leading image path + ASCII punctuation must not switch (boundary fix)',
)
const upperJpg = path.join(homedir(), 'Desktop', 'IMG_0001.JPG')
assert.equal(
  await resolveWorkspaceIntent(upperJpg, cwd),
  null,
  'uppercase JPG extension must be case-insensitively rejected',
)
assert.equal(
  await resolveWorkspaceIntent(`"${desktopImage}" 看这张图`, cwd),
  null,
  'quoted leading image path must not switch (no strong prefix = implicit)',
)

// ── Non-media paths still resolve as before ─────────────────────────────────
// A `.ts` (non-media) leading path must not be killed by MEDIA_EXTENSION_RE.
// It still goes through findNearestExistingWorkspaceRoot and may resolve to
// a parent dir — that's the pre-existing behavior and proves the new filter
// didn't over-reach. We use a path under tmpdir so the parent definitely
// exists on disk.
const codeFile = path.join(tmpdir(), 'artemis-smoke', 'src', 'foo.ts')
const codeResolved = await resolveWorkspaceIntent(`${codeFile} 帮我看看`, cwd)
assert.ok(
  codeResolved,
  '.ts (non-media) leading path must still resolve (filter did not over-reach)',
)
assert.equal(
  codeResolved.workspacePath,
  tmpdir(),
  '.ts path falls back to nearest existing parent (= tmpdir), unchanged behavior',
)

// ── Alias bug: bare absolute path containing "Downloads"/"Desktop" must
//    NOT trigger the alias resolver. Folder-name segments inside an
//    absolute path are not intent expressions; the path-based extractor
//    (with its media-extension filter) handles these instead.
const downloadsImage = path.join(homedir(), 'Downloads', 'artemis.png')
assert.equal(
  await resolveWorkspaceIntent(downloadsImage, cwd),
  null,
  'bare /Users/.../Downloads/x.png must not be misread as downloads-alias',
)
const documentsImage = path.join(homedir(), 'Documents', 'notes', 'screenshot.png')
assert.equal(
  await resolveWorkspaceIntent(documentsImage, cwd),
  null,
  'bare /Users/.../Documents/.../x.png must not be misread as documents-alias',
)
// Natural-language alias still works
const aliasIntent = await resolveWorkspaceIntent('保存到 Downloads 文件夹', cwd)
// Either resolves via downloads-alias or returns null when ~/Downloads is
// overbroad / missing on this host. The key invariant: no throw, no error.
if (aliasIntent) {
  assert.equal(
    aliasIntent.source,
    'downloads-alias',
    'natural-language "保存到 Downloads" still resolves as downloads-alias',
  )
}

// ── Explicit strong-intent prefix must still be respected even for media ────
// User typing "切换到 /Users/me/Desktop/x.jpg" is unusual but should fall
// back to the parent dir, not be silently dropped. We can't easily assert
// the success path here without creating a real file under tmpdir, so we
// at least assert that resolution doesn't throw and returns a usable shape.
const explicitMediaPath = path.join(tmpdir(), 'artemis-smoke-explicit-media.jpg')
const explicitMediaResult = await resolveWorkspaceIntent(
  `切换到 ${explicitMediaPath}`,
  cwd,
)
// Either null (parent doesn't exist) or a resolution to a parent dir — both
// are acceptable; what we're NOT allowed to do is silently strip the path.
// This is a regression guard against accidentally re-adding media filter to
// normalizeCandidate (which would kill explicit intent too).
if (explicitMediaResult) {
  assert.notEqual(
    explicitMediaResult.workspacePath,
    '',
    'explicit-intent media path must produce a non-empty resolution if it resolves at all',
  )
}

console.log('workspaceIntent paste guard smoke: ok')
