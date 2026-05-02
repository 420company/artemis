import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { resolveWorkspaceIntent } from '../src/cli/workspaceIntent.js'

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

const explicit = await resolveWorkspaceIntent(`进入 ${tmpdir()} 继续检查`, cwd)
assert.ok(explicit)
assert.equal(explicit.workspacePath, tmpdir())

const englishExplicit = await resolveWorkspaceIntent(`switch to ${tmpdir()} and inspect`, cwd)
assert.ok(englishExplicit)
assert.equal(englishExplicit.workspacePath, tmpdir())

console.log('workspaceIntent paste guard smoke: ok')
