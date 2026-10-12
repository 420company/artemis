# Errands: the agent carries real-world tasks end to end

When the owner asks for something to be done in the world — rent two VPN
servers, book a table, deploy a site, send a sheet to someone — the agent
does it itself and keeps the owner informed, instead of answering with
instructions. This document covers the engine side: the playbook, live
updates and status, and the helpers for server setup, secrets and codes.
The platform side (stream, list, Telegram, web) is in artemis-online
`docs/LIVE-PROGRESS.md`.

## Playbook (`core/operatorPlaybook.ts`)

- **Principle** (every routed run, in `COMMON_AGENT_PROTOCOL`): do what the
  user would otherwise do by hand; only hand over what is impossible or must
  not be done by the agent, and say why; verify before saying "done".
- **Full playbook** (added to the run's hint when `looksLikeOperatorTask`
  matches, and for follow-ups of that conversation for six hours;
  `services/headlessWorkflow.ts`, `workflowRouting.operatorActiveAt`):
  goal → requirements → resources → plan → act → verify → hand over, and the
  hard rules: do, don't instruct; the only human touchpoints are payment
  approval, secrets the user must type, identity checks, CAPTCHAs and real
  preferences, bundled and announced in advance; at most one bundled question
  with defaults; reuse what is known (memory, earlier answers, connected
  accounts); never invent prices or stock; report surprises at once with 2–3
  options and one recommendation; stop before paying/sending/submitting with
  the full bill; acknowledge at once and post short updates; end with one
  next-step offer and do it on "yes". Chinese first, English variant.

## Live updates: `post_update` → `[agent-update]` (`core/agentUpdates.ts`)

`post_update {text}` shows one or two sentences to the user at once while the
run goes on. Limits: 280 characters, no cards or code blocks, no exact
repeats, a burst of 2 then one per 8 s, 12 per run. Each delivered update is
one stderr line:

```
[agent-update] {"id":"upd_<16 hex>","text":"…","at":"<ISO>","seq":1}
```

The tool result message records `agentUpdate: {id, text}`; the chat history
(`session show`) lists it as an assistant message with `kind: "update"` and
`updateId`, in order. Hosts without a live channel (the interactive CLI)
refuse the tool with `updates_unavailable`. Main profile only.

## Live status: `[agent-status]` (`core/agentStatus.ts`)

Derived from tool starts and ends (`RunAgentOptions.onToolActivity`), never
from model text:

```
[agent-status] {"phase":"working","activity":"filling_form","detail":"example.com","at":"…","seq":7}
```

Phases `working | waiting_user | waiting_approval | done`; activities are
codes (`thinking`, `browsing`, `reading_page`, `filling_form`, `clicking`,
`searching`, `waiting_handoff`, `waiting_confirmation`,
`waiting_payment_approval`, …) the host words. `detail` is only ever a host
name. With parallel tools the latest still running wins.

Adapters for branches not merged yet:
- live browser: `browser_request_handoff` already maps to
  `waiting_user/waiting_handoff`;
- hard approvals: where the headless run stops at an approval request,
  call `agentStatus.finish(statusForApprovalKind(result.approval.kind))`
  instead of `finish()` (comment in `services/headlessAgent.ts`).

## Server setup (`tools/serverSetup/`)

`server_setup` actions: `create_key` (Ed25519, private key in the credential
store, public key returned for the provider's form; optional `host` ties it
to one server, otherwise one key serves the servers of one order — a key
login reveals nothing secret to the server), `create_password` (needs
`origin` and/or `host`; typed with `{{credential:<name>}}` as the whole value
of a password field on that origin only), `install_key` (password-only
servers, through `SSH_ASKPASS`; only a `password` bound to that host),
`wait_ready`, `harden` (updates, firewall, automatic security updates,
key-only SSH through `sshd_config.d/00-agent-hardening.conf`, then checked
with `sshd -T` — the step fails if password login is still on; an installed
WireGuard keeps its port and forwarding), `install_wireguard` (IPv4
forwarding only; device profiles and QR codes under
`<ARTEMIS_HOME>/vpn-profiles/<server>/`, 0700/0600, never in the workspace;
the result carries ```vpn {"server","device"}``` cards for the reply),
`verify` (`ssh`, `wireguard` — with a real tunnel through a temporary peer
and network namespace when the machine allows it — or `url`), `run`,
`list_servers`, `record_server` (inventory in `<ARTEMIS_HOME>/servers.json`),
`forget_host_key` (only with the owner's approval: the hard-approval gate,
else the host's confirmation, else refused).

Where SSH runs: with the hosted credential service, the server runs it (the
store's `ssh`: the engine sends the script and the credential's name, the
server checks the binding and runs `ssh` as its own OS user, with the key in
a server-only temporary file and the password over an askpass socket), so a
key or root password never reaches the engine or the agent's OS user; the
device profiles go to the server too (`storeVpnProfile`), and no profile
file is written. Locally (the CLI) the engine fetches the secret and runs
`ssh` itself.

SSH trusts a server's key on first use (`<ARTEMIS_HOME>/agent-ssh/known_hosts`
locally; the server's own known hosts when hosted). A changed key fails at
once with `host_key_changed` — no waiting loop — and the agent stops and
tells the owner. `forget_host_key` asks for approval as a `confirmation`,
the always-ask kind (never "always allow"); without an approval channel it is
refused.

The QR encoder (`qr.ts`) matches a reference encoder bit for bit.
`ARTEMIS_SSH_BIN` replaces `ssh` (tests use `scripts/fixtures/fakeSsh.mjs`,
which also models reinstalls, sshd overrides and lockout after hardening).

## Credentials (`security/credentialStore.ts`)

Kinds `password`, `username`, `ssh_key`, `token` (VPN keys). Every use is
checked against what the credential is for:

- web: only on its bound origin (bound when made, or at first use), a
  password only into an `<input type=password>`, a username only into a
  username/email input; the placeholder must be the whole value;
- SSH: a password only as the login of its bound host; a web password is
  never an SSH password and the other way round;
- `token`: only the engine's own server setup.

Every secret handed out is remembered for the run and replaced by `••••` in
every tool result (foreground and background), so a page echoing it, a
console line or an extract never brings it into the history; scripts
(`browser_evaluate`) do not run on an origin where a credential was typed.

Backends:

- hosted: the web server hands each run the service's loopback address and a
  one-time claim code with the per-run headers on the inherited descriptor
  (entry `artemis_credentials`; an older host: `ARTEMIS_CREDENTIAL_BROKER`,
  removed from the environment at start); the engine trades the claim for a
  ticket before any tool runs and asks the server with it. Secrets live in the server's data
  directory, out of the agent user's reach; the server generates keys and
  passwords and checks every use against the binding;
- local CLI: `<ARTEMIS_HOME>/agent-credentials` (0700 dir, 0600 files;
  `ARTEMIS_CREDENTIALS_DIR` overrides).

The agent's own file and shell tools refuse `agent-credentials` and
`vpn-profiles` paths in every mode. That refusal is a limit for mistakes,
not a guard: a shell can build the name. What keeps the hosted secrets from
the agent is that they are the server's. A host can register another backend
(`registerCredentialStore`), e.g. a vault that fills an origin-bound field
itself without handing the secret to the engine. Secrets another module
keeps plug in by name prefix (`registerCredentialResolver('signup-', …)`
for the agent identity's sign-up passwords): the binding in what the
resolver returns is checked the same way, and the secret is scrubbed the
same way. Every typed value goes through `resolveCredentialValue` in
`tools/browser/browserTools.ts` (also used by the offline eval browser).

### The owner's own secrets

When a step needs a secret only the owner has (their account password on a
site, a server's root password, a PIN, an API key), the hosted platform
offers the MCP tool `request_owner_secret {purpose, kind, bind: {origin} |
{host}, label}`. The agent gets a placeholder `{{credential:owner-…}}` and a
```secret {"id"} card to put in its reply; the run ends waiting
(`statusAtEnd` → `waiting_user / waiting_secret`). The owner types the
secret into the card in the web app; it goes straight into the server's
encrypted store, bound to that site or server, and the chat only says
已保存（仅用于 …）. The placeholder then types like any stored password, under
the same rules. An item the owner locked with their own key (你持钥匙) answers
`locked` with an unlock card: the agent shows it and stops
(`waiting_unlock`); after the owner unlocks it, the placeholder types again.
Typed secrets are masked in screenshots of the site they were
typed on (and only there), a password field is never read back by
`browser_extract_text`, and every result is scrubbed of the secret in its
plain, URL, JSON, HTML, base64 and hex forms.

## Verification codes (`tools/verificationCodes.ts`)

`get_verification_code {channel: email|sms|which, sender, timeoutSeconds?}`
uses `getVerificationCode(channel, sender, timeout)`: a registered
`VerificationCodeSource` or a host program in
`ARTEMIS_VERIFICATION_CODE_CMD` (called with `--channel= --sender=
--timeout= --since=`, prints `{"code": "…"}`). `sender` is required and only
codes from the last three minutes count, so another site's code is never
taken. Without a source the model hands the step to the owner or asks for
the one-time code — never a password.

## Tests

- `npm run test:copilot` (part of `test:runtime`): update limits and ids,
  history projection, status from tool activity and at the end of a run,
  envelope parsing, errand detection and routing, credential bindings,
  scrubbing and the broker, key formats, QR, `server_setup` against the fake
  SSH server (no secret in any output, hardening checks, host key changes,
  lockout), codes adapter.
- `npm run test:credentials-browser`: credential typing and scrubbing in a
  real headless Chromium (skipped without one).
- `npm run eval:zh:mock`: the `errand` category (`evals/zh/README.md`) —
  golden VPN scenario, restaurant, deploy, and ten do-not-instruct requests,
  against an offline web and a fake SSH server.
