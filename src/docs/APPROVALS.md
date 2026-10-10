# Hard approvals

Some actions must never run on the agent's word alone. Before this, approvals
were soft: a ```confirm card was text the model wrote, `request_user_confirmation`
always failed in a headless run, and high-risk shell commands were simply
refused. Now the engine stops at such an action and keeps the request; only
its host can answer it, once, for the owner (the web server shows it as a
locked card and in Telegram; see artemis-online `docs/APPROVALS.md`).

## What needs approval

| Kind | When | Default |
|---|---|---|
| `confirmation` | The agent asks with `request_user_confirmation` | always asks (not configurable) |
| `shell_high_risk` | `run_command` matching the high-risk classifier (`curl … \| sh`, reverse shells, decoded payloads) | ask |
| `delete_outside_workspace` | `rm`/`rmdir`/`unlink`/`shred`/`find … -delete` (and `delete_file`/`delete_directory`) on paths outside the workspace; the temp dir is exempt | ask |
| `outbound_send` | `bridge_send_*`, MCP tools that send (email, message, post, …) | ask |
| `payment` | MCP tools that pay, buy, order, transfer, trade; tools that call `requireApproval('payment', …)` | ask |
| `publish` | MCP tools that publish, share, deploy; tools that call `requireApproval('publish', …)` | ask |

Modes per kind: `ask` (每次询问), `allow` (总是允许), `deny` (禁止). The owner sets
them in 权限与安全; the server writes them to the engine's policy file,
`<engine data root>/approvals.json` (`{"version":1,"modes":{…},"ttlMinutes":1440}`).
The engine also reads `~/.artemis/approvals.json`; the workspace file wins.
Requests expire after 24 hours unless `ttlMinutes` says otherwise.

## Protocol (engine ⇄ host)

1. **Stop.** In `artemis execute`, an ask-mode action is not run. The engine
   stores a pending record in the session (`session.approvals`: the exact
   action, its sha256, an HMAC over id, session, kind, times, digests and host
   binding, keyed by `~/.artemis/approvals.key`), tells the model it waits,
   skips the rest of that turn's actions, and prints on stderr:

   ```
   [approval-request] {"id":"apr_<20 hex>","kind":"shell_high_risk","title":"…","summary":"…",
     "details":{"command":"…"},"risk":"high","createdAt":"…","expiresAt":"…",
     "sessionId":"<uuid>","locale":"zh-CN"}
   ```

   The summary panel is printed as usual (one plain line says what waits) and
   the process exits **10** (`APPROVAL_REQUIRED`). Title and summary are plain
   words in the owner's language, without tool or system names; the raw action
   never leaves the engine.

2. **Answer.** `artemis execute --session <id> --approve <request id>` or
   `--deny <request id> [--reason <text>]` (no message). Under the session
   lock the engine checks the request exists, is pending, has not expired,
   still matches its HMAC (any edit of the stored action, digest or expiry
   makes it unusable), and — when the run was host-bound — that the caller
   presents the same host secret. It marks the request used *before* acting.
   Approve runs exactly the stored action once (the policy still applies: a
   kind switched to `deny` meanwhile is refused); deny runs nothing. The result
   (or the refusal, with the owner's reason) is recorded as the tool result and
   the model continues on the original request. It prints
   `[approval-result] {"id","decision"}`. A refused answer prints
   `[approval-error] {"id","code"}` (`approval_not_found`, `approval_already_used`,
   `approval_expired`, `approval_tampered`, `approval_unauthorized`) and exits
   **11** (`APPROVAL_REJECTED`).

3. **Host binding.** A host passes a per-run secret in `ARTEMIS_APPROVAL_SECRET`.
   The engine removes it from its environment before any tool, shell or MCP
   server starts and stores only its hash with the request; an answer must
   carry the same secret. The agent's shells are marked (`ARTEMIS_AGENT_TOOL=1`)
   and refused as answerers, and `run_command` refuses commands that try to
   answer an approval.

`ARTEMIS_APPROVALS=off` turns suspension off (ask-mode actions are refused, as
before). Interactive hosts (the CLI, chat bridges) ask through their own
confirmation instead of stopping. Sub-agents never stop the run: they refuse
and report, so the main agent asks.

### For tools: `requireApproval(kind, request)`

```ts
import { requireApproval } from '../security/approvals.js'

const gate = await requireApproval('publish', {
  payload: { site: 'sites/demo', visibility: 'public' }, // exactly what will happen
  details: { target: 'https://demo.example' },
})
if (!gate.ok) return { action, ok: false, output: gate.output, error: gate.error }
// …the irreversible step
```

Call it right before the irreversible step. In a headless run the first call
stops the run; after `--approve` the same tool call runs again and passes here
once, for the same payload only (its digest is part of the HMAC). A tool can
also register how its actions are classified with `registerApprovalRule`.

## Tests

`npm run test:approvals` (part of `test:runtime`): policy, classifier, suspend,
approve, deny, expiry, replay, tamper, host binding, `requireApproval`, CLI flags,
and a headless end-to-end run.

## Limits


The agent runs as the same Unix user as the server on a VPS; the key file,
policy file and host's store are protected from the agent's file and shell
tools (protected paths), not by the operating system. The host secret means a
request cannot be answered by re-running the engine without it.
