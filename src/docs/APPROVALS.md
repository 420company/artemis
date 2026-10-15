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
| `shell_high_risk` | `run_command` matching the high-risk classifier (below): remote or hidden code, a command built at run time, data sent out, reverse shells, lock-outs; a web server other machines can reach (medium risk, below); and every `server_setup run` off the read-only allowlist | ask |
| `delete_outside_workspace` | Deleting, moving away or overwriting anything outside the workspace (`rm`, `find -delete/-exec`, `mv`, `> file`, `truncate`, `dd of=`, `git clean`, `rsync --delete`, `tee`, `sed -i`, `chmod/chown/chgrp -R`, `cp`/`install`/`ln -f` onto an existing file or into a place whose files run later (login scripts, autostart entries, services, cron, `.ssh`, and command directories the agent can write: `~/bin`, `~/.local/bin`, writable `PATH` entries, where a new file shadows a command), appends `>> file` (a line added to `~/.bashrc` runs later), inline code that opens a file for writing, downloads saved there (`curl -o/--output/-O/--output-dir`, `wget -O/-P` or into the current directory), …, and `delete_file`/`delete_directory`/`move_file`), and any delete or write whose target cannot be worked out | ask |
| `outbound_send` | `bridge_send_*`, external tools that send, post, reply, submit | ask |
| `payment` | External tools that pay, buy, order, transfer, sign or broadcast a transaction; tools that call `requireApproval('payment', …)` | ask |
| `publish` | External tools that publish, share, deploy; tools that call `requireApproval('publish', …)` | ask |
| `external_action` | Other external tools that change something (delete, drop, execute, generic HTTP requests) and tools whose server does not declare them read-only | ask |

Modes per kind: `ask` (每次询问), `allow` (总是允许), `deny` (禁止). External
tools can also have a mode of their own, keyed `server/tool` or `server/*`.

**The shell classifier** (`security/shellRisk.ts`) fails closed: a shell
is a language, so whatever hides what will run asks, whatever the inner
content is.
- Built at run time: a substitution, a variable (other than `$HOME/…`), an
  ANSI-C string (`$'\x72m'`) or a glob as the command word; `eval`; a shell
  given `-c` code with a substitution or variable in it; `source`/`.` of a
  process substitution or of stdin; a pipe, here-string, or here-document
  into a shell or into an interpreter (sh, bash, zsh, python, perl, node,
  ruby, …) that reads its program from stdin (`| sh`, `| python3 -`,
  `bash <<< …`; data piped into `python3 -c '…'` or a script is fine; a
  quoted here-document program for python/node is fine, an expanding one
  with a substitution is not); `xargs`/`parallel`/`find -exec` into a
  shell; `env -S`; inline code that decodes and runs (`exec(b64decode(…))`).
  printf/echo escapes, base64/xxd/openssl/tr/rev and friends feeding any of
  these are reported as decoding.
- Sending data out: `curl` with a body or upload in any spelling (`-d`,
  `--data*`, `--json`, `-F`, `-T`, combined short flags), `wget
  --post-*/--body-*`, `nc`/`ncat`/`netcat` (except `-z` port checks),
  `socat`, `telnet`, `/dev/tcp`, `scp`/`rsync` to a remote host, `sftp`,
  data piped into `ssh`, inline code with a network send (`urlopen(url,
  data)`, `requests.post`, sockets, `fetch` with a body, …).
- Commands run through a program's options or settings: `git -c` with a
  key that runs something (`core.sshCommand`, `core.pager`, `core.editor`,
  `core.fsmonitor`, shell aliases, …) and `GIT_SSH_COMMAND`,
  `GIT_EXTERNAL_DIFF` and friends (`GIT_PAGER=cat` is fine); `tar
  --to-command`/`--use-compress-program`/`--checkpoint-action=exec`; an
  editor's `-c`/`+`/`--cmd` with `!`; `less`/`more` with `!` or
  `LESSOPEN`; awk's `system(`; `find -exec` of anything but a read-only
  command (`ls`, `cat`, `grep`, `wc`, `stat`, …); `rsync -e`; `ssh -o
  ProxyCommand=`.
- Lock-outs: firewall changes (`iptables`/`nft`/`ufw`/`firewall-cmd`
  other than listing), stopping, disabling or masking SSH, locking or
  removing users, `kill -1`/`kill 1`, removing packages, `crontab -r`,
  formatting or partitioning disks, shutdown and reboot.
Here-document bodies are text, not commands: a body written to a file is
not classified, a body that is a program is checked as inline code.

**Web servers** (`listeningServers`): a known static or script server
(`python -m http.server` / `SimpleHTTPServer`, `php -S`, `http-server`,
`serve`, `busybox httpd`, also through `nohup`, `setsid`, `npx` or `sh -c`)
bound only to the loopback interface (`--bind 127.0.0.1`, `-b ::1`,
`localhost`) needs nothing: only this machine reaches it. Bound anywhere
else, or by default (python's http.server binds every interface unless told
otherwise), or with an option or a variable the classifier cannot read, it
asks as `shell_high_risk` with **medium** risk ("a web server other
machines may reach"). A server the classifier does not know is not
classified (it is code like any other).

**Directories.** A `cd` to a static path is followed. A subshell (`(cd x
&& …)`), `cd -`, `popd` or a cd that fails puts the shell back where it
was, so a relative target must be fine from every directory the command
may be in at that point (the start and every static cd before it); a cd to
a place not known before it runs makes relative targets unknown. The
temp dir (`$TMPDIR`, `/tmp`, `/var/tmp`, after following links) counts as
the agent's scratch space: a new log there (`> /tmp/x.log 2>&1`) needs
nothing.

**What the card says.** The title and summary come from what the command
was classified as doing (`summarizeShellCommand`): "启动本地预览：在本机
127.0.0.1:8731 打开工作区 sites/x 里的网页（只有 agent 自己能访问）", "把输出写进
新的临时文件 /tmp/x.log", "检查本机网页 … 能否打开", "把 … 下载到 …", a write
or a delete outside the workspace with its paths. A delete is only called a
delete when the command removes something (`rm`, `find -delete`, `mv`
away); a write is called a write. When the targets cannot be worked out the
card says what is known ("删除文件（位置无法事先确定）"), and when nothing is,
it is neutral ("运行一条需要你确认的命令") and claims no deletion.

**Commands on a server (`server_setup run`).** The agent is root on the
owner's server, so a command there asks unless it is on a short allowlist
of read-only commands with plain arguments (`readOnlyServerCommand`):
`uptime`, `df`, `free`, `uname`, `whoami`, `nproc`; `cat`, `ls`, `head`,
`tail`, `stat` of paths that hold no secrets (not `shadow`, `sudoers`,
`.ssh`, key files, `.env`, histories, `wireguard`, `private`, `secrets`,
`/proc/<pid>/environ`, devices, …); `systemctl
status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers`;
`journalctl` (reading options only, no `--vacuum-*`/`--rotate`); `ss`
and `netstat` (no `-K`); `ip addr|route|link|neigh|rule` show/list; `ufw
status`; `wg show` (not `private-key`, `preshared-keys` or `dump`);
`docker ps`, `docker logs`; and `grep` (no recursion, no pattern file),
`wc`, `sort` (no `-o`), `uniq` (one operand), `head`, `tail` to filter
them. They may be joined by `;`, `&&`, `||` and `|`; any substitution,
variable, redirection, glob, escape, comment, background job or line break
asks. Off the list everything asks as `shell_high_risk`: high risk for
remote code, data sent out, lock-outs and deletes or overwrites, medium
for the rest ("runs a command as root on the server").

**Where the policy comes from.** The host's copy, `ARTEMIS_APPROVAL_POLICY`
(`{"modes":{…},"tools":{…},"ttlMinutes":1440}`), is the base. The web server
keeps the owner's choices from 权限与安全 in its own data dir, where the agent
cannot write, and passes them to every run. The files the agent can reach,
`~/.artemis/approvals.json` and `<engine data root>/approvals.json`, can only
**tighten** it: a stricter mode for a kind (deny > ask > allow), a per-tool
`ask`/`deny`, or a shorter expiry. `allow` in a file is ignored. Requests
expire after 24 hours unless the policy says otherwise.

**The host's own tools.** A host can let its own MCP tools through, as
defaults apart from the owner's entries (`"defaults":
{"artemis_online/*": "allow"}`), and names its own MCP servers with their
exact URL (`"hostServers": {"artemis_online": "<url>"}`): its payment tools
(`pay_x402`, `transfer_to_allowlisted`, `request_swap`) are approved and
limited by its payments service, its publish requests wait for the owner in
its app, so the owner is not asked twice. An `allow` for a tool of a named
server (a default or an owner's entry) holds only while the MCP config the
call uses still points that id at that URL; elsewhere the kind's mode
applies. A kind the owner turned off (`deny`) wins over every default and
over the connectors broker's gate; only the owner's own entry for that exact
tool (`server/tool`) overrides it. Only the host's copy sets `defaults`,
`hostServers` and `connectorServers`.

**Which config a call uses.** An MCP call's server entry is read once,
from the directory the call runs in (a `cd` changes it): the gate takes the
server's URL from that entry and the call is made with exactly that entry
(a credential rotated by the host is picked up on a refused call only when
the URL is unchanged). Whether a tool only reads comes from the server's
own `tools/list`, asked by the engine (cached per URL), never from the
model and never from the tool list cached in `mcp-servers.json`, which the
agent can write; a server that cannot be asked is not read-only.

**Per-run headers** (`mcp/inheritedHeaders.ts`) follow the v2 payload the
host writes on the inherited descriptor: `{"v": 2, "servers": {"<id>":
{"url", "headers"}}}`. Server ids match exactly, and a server's headers go
only to an entry whose URL is the one the host named, so the run's token
never follows the name to another URL. An entry with a `target` is for the
model proxy only; one with neither is the engine's own (the credential
broker's claim).

**Messages that are not the owner's.** A new message ends the requests
still waiting in its conversation, but only the owner's: the host passes
`--keep-approvals` for a message it sends on its own (a scheduled task, a
trigger, a call's follow-up, a connector that became ready), and those
requests stay as they are.

**Servers the agent sets up (`server_setup`).** Setting up a server the
owner had the agent rent (keys, `install_key` with the root password the
owner saved for exactly that server, `harden`, `install_wireguard`, checks)
is the task the owner asked for: no second request. `forget_host_key` asks
the owner itself through `requireApproval('confirmation', …)`, which no
policy can allow; on an interactive host it is asked like any other
request (only the model's own `request_user_confirmation` asks itself).
`run` is a command as root on that server: see the allowlist above. The
SSH itself runs on the host when it offers a credential broker, so a key or
password never reaches the agent. The VPN setup takes nothing from the
inventory (`servers.json`, which the agent can write) unchecked: the server
and device keys are the credential store's, named `<server>-wg-…` and made
for that server (a VPN key purpose names the server, so no other token can
be used as one), the subnet, port and addresses come from the store's notes
or are checked, and every value goes into the script as a checked, quoted
argument (`wg0.conf` is written with `printf`, never an expanding
here-document).

**The host's own tools for the owner's secrets.** A host's tool that asks
the owner for a secret of theirs (`request_owner_secret` on the platform)
only shows the owner a box to type it into, outside the chat; the owner's
own step is the gate, and the host's policy names its tools as allowed
(`artemis_online/*`), so nothing asks twice. Unlocking a secret the owner
holds the key to is the owner's own wallet step on the host.

**Connected services.** A host whose connectors broker asks the owner
before every write of a connected service names the broker's servers in its
copy of the policy: `"connectorServers": {"conn_<connection>": "<broker URL>"}`.
A tool of such a server runs without a second request here only when the
live MCP config (`mcp-servers.json`, which the agent can write) still points
that server id at exactly that URL; a `conn_…` server the host did not name,
or a named one whose URL was changed, asks like any other external tool. The
owner can still set a mode for the service or tool, and a policy file can
still forbid it; only the host's copy can name brokers. *Follow-up:* the
broker's cards and these cards are still two systems; they should become one
(the broker raising its writes through `requireApproval`, one card per
action).

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

Outside an agent run (a tool called directly) nobody can be asked, so only
the policy decides and `confirmation` is refused. `tools/ownerApproval.ts`
(`requireOwnerApproval`, used by `forget_host_key`) then lets a host that
asks the owner itself (`requestUserConfirmation`, the interactive CLI)
decide; inside a run, the run's gate always decides (`inApprovalRun()`).

**Live status.** A headless run that stops at a request, first run or
resumed, ends its `[agent-status]` with `waiting_approval` and the kind's
activity (`waiting_payment_approval`, `waiting_send_approval`,
`waiting_publish_approval`, else `waiting_confirmation`).

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
