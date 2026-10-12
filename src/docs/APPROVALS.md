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
| `shell_high_risk` | `run_command` matching the high-risk classifier: a fetch piped or substituted into an interpreter (also via `sudo`/`env`, `bash <(curl …)`, `sh -c "$(curl …)"`), a downloaded or decoded file that is then run, uploads (`curl -d/--data*/-F @file`, `-T`, `wget --post-file/--post-data`), reverse shells | ask |
| `delete_outside_workspace` | Deleting, moving away or overwriting anything outside the workspace (`rm`, `find -delete/-exec`, `mv`, `> file`, `truncate`, `dd of=`, `git clean`, `rsync --delete`, …, and `delete_file`/`delete_directory`/`move_file`), and any delete whose target cannot be worked out | ask |
| `outbound_send` | `bridge_send_*`, external tools that send, post, reply, submit | ask |
| `payment` | External tools that pay, buy, order, transfer, sign or broadcast a transaction; tools that call `requireApproval('payment', …)` | ask |
| `publish` | External tools that publish, share, deploy; tools that call `requireApproval('publish', …)` | ask |
| `external_action` | Other external tools that change something (delete, drop, execute, generic HTTP requests) and tools whose server does not declare them read-only | ask |

Modes per kind: `ask` (每次询问), `allow` (总是允许), `deny` (禁止). External
tools can also have a mode of their own, keyed `server/tool` or `server/*`.

**Where the policy comes from.** The host's copy, `ARTEMIS_APPROVAL_POLICY`
(`{"modes":{…},"tools":{…},"ttlMinutes":1440}`), is the base. The web server
keeps the owner's choices from 权限与安全 in its own data dir, where the agent
cannot write, and passes them to every run. The files the agent can reach,
`~/.artemis/approvals.json` and `<engine data root>/approvals.json`, can only
**tighten** it: a stricter mode for a kind (deny > ask > allow), a per-tool
`ask`/`deny`, or a shorter expiry. `allow` in a file is ignored. Requests
expire after 24 hours unless the policy says otherwise.

**The host's own tools.** A host can let its own MCP tools through
(`artemis-online` passes `artemis_online/*: allow`): its payment tools
(`pay_x402`, `transfer_to_allowlisted`, `request_swap`) are approved and
limited by its payments service, its publish requests wait for the owner in
its app, so the owner is not asked twice.

**Connected services.** A host whose connectors broker asks the owner
before every write of a connected service (MCP servers named
`conn_<connection>`) says so in its copy of the policy
(`"connectorsGated": true`); those tools then run without a second request
here, unless the owner set a mode for that service or tool, or a policy file
forbids it. Only the host's copy can say this. *Follow-up:* the broker's
cards and these cards are still two systems; they should become one (the
broker raising its writes through `requireApproval`, one card per action).

**What counts as read-only.** For an external tool, only the server's own
description (its `readOnlyHint`, kept in the tool list) says it is read-only.
The model's arguments never do, and an unknown server or tool is not
read-only. Tool names are split into words (`chat_postMessage` → chat, post,
message; `eth.sendTransaction` → eth, send, transaction), after folding
look-alike letters (NFKC, accents and invisible characters removed, Cyrillic
and Greek look-alikes read as Latin; the card then shows the real characters
as code points); a word that sends,
pays, signs, submits, deletes or executes always asks, even if the tool is
also called "get" or "list" or is marked read-only.

**Shell classification is best effort.** A shell command can hide what it
does in countless ways. The classifier fails closed where it can (variables,
substitutions, brace expansion, `eval`, `xargs`, inline interpreter code,
unknown wrappers, `cd` to a place it cannot follow, function bodies, combined
inline-code flags such as `bash -lc`, awk programs that run commands, a
variable run as the command: any delete it cannot place asks), and resolves symlinks (a link in the workspace or the temp dir that
leads elsewhere is elsewhere). It is still a classifier, not a sandbox; the
real boundary is the agent's own Unix user (see Limits).

## Protocol (engine ⇄ host)

1. **Stop.** In `artemis execute`, an ask-mode action is not run. The engine
   stores a pending record in the session (`session.approvals`: the exact
   action, its sha256, the owner message it came from, and a MAC), tells the
   model it waits, skips the rest of that turn's actions, and prints on stderr:

   ```
   [approval-request] {"id":"apr_<20 hex>","kind":"shell_high_risk","title":"…","summary":"…",
     "details":{"command":"…"},"risk":"high","createdAt":"…","expiresAt":"…",
     "sessionId":"<uuid>","locale":"zh-CN","actionDigest":"<sha256 of the stored action>"}
   ```

   The process exits **10** (`APPROVAL_REQUIRED`). Title and summary are plain
   words in the owner's language, without tool or system names. `details`
   carries what will run with stable keys: `command`; `to`, `cc`, `bcc`,
   `subject`, `attachments`, `content`; `amount`, `currency`, `quantity`,
   `merchant`; `service`, `action`, and `args` (every argument of an external
   tool, as canonical JSON with sorted keys). Nothing is cut silently: a value
   over 20000 characters is cut and `"truncated": true` is set, and the host
   then shows that and lets the owner approve only after seeing the full card.

2. **Answer.** `artemis execute --session <id> --approve <request id>` or
   `--deny <request id> [--reason <text>]` (no message), with
   `--expect-digest <actionDigest>` (the digest the host stored when the
   request arrived) and `--signature <base64>`. Under the session lock the
   engine checks that the request exists, is pending, has not expired, still
   matches its MAC and digest, and that the host's digest matches the stored
   action; then it checks the signature (below). It marks the request used
   *before* acting and prints `[approval-result] {"id","decision"}`: from that
   line on, the answer has been taken. Approve runs exactly the stored action
   once (the policy still applies: a kind switched to `deny` meanwhile is
   refused); deny runs nothing. The result (or the refusal, with the owner's
   reason) is recorded as the tool result and the model continues on the
   owner's message the request came from. A refused answer prints
   `[approval-error] {"id","code"}` (`approval_not_found`,
   `approval_already_used`, `approval_expired`, `approval_tampered`,
   `approval_unauthorized`) and exits **11** (`APPROVAL_REJECTED`); nothing ran.

3. **Signed answers.** The host owns an Ed25519 key pair. Its private key never
   leaves the host's data dir; the engine gets only the public key, in
   `ARTEMIS_APPROVAL_PUBKEY` (base64 SPKI DER). Each request records which key
   it is bound to (sha256 of that public key), and an answer to it is accepted
   only with the host's signature over the canonical JSON

   ```
   {"actionDigest":"…","approvalId":"apr_…","decision":"approve|deny","expiresAt":"…","sessionId":"…","v":1}
   ```

   A signature cannot be made from anything the agent can read, so the agent
   cannot answer its own request, even by running the engine itself with a
   key pair of its own (the request stays bound to the host's key). The
   agent's shells are also marked (`ARTEMIS_AGENT_TOOL=1`) and refused as
   answerers, and `run_command` refuses commands that try to answer an
   approval or read the approval key.

   *Development only:* a run started without `ARTEMIS_APPROVAL_PUBKEY` (the
   engine run by hand) records unbound requests, which `--approve` answers
   without a signature. Hosts that serve an owner always pass the key.

4. **Stale requests.** When the owner writes again in the conversation,
   requests still waiting from earlier turns expire and the engine prints
   `[approval-result] {"id","decision":"expired","reason":"superseded"}`
   for each, so a late answer can never run an old action.

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

Call it right before the irreversible step. The payload is shown in full on
the card (`details.args`). In a headless run the first call stops the run;
after `--approve` the same tool call runs again and passes here once, for the
same payload only (its digest is part of the record). A tool can also
register how its actions are classified with `registerApprovalRule`.

## Tests

`npm run test:approvals` (part of `test:runtime`): policy (host base, files
only tighten), classifier (read-only from the server only, tool names,
fail-closed deletes through symlinks, download-and-run, uploads), suspend,
approve, deny, expiry, replay, tamper, signatures (unsigned, wrong key,
replayed), stale requests, `requireApproval`, CLI flags, and a headless
end-to-end run.

## Limits

The engine's checks are only as strong as the boundary around the agent.
With agent isolation (artemis-online `docs/AGENT_ISOLATION.md`) the agent runs
as its own Unix user: it cannot read the host's private key or data dir, so
it cannot produce an answer the engine accepts. The MAC key
(`~/.artemis/approvals.key`) and the policy files are protected from the
agent's file and shell tools, but they are not a security boundary; the
host's signature and stored digest are. Without isolation (agent and host as
the same user) a determined agent could reach the host's key.
