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

console.log('workspaceIntent paste guard smoke: ok')
