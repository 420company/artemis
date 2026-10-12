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

`server_setup` actions: `create_key` (Ed25519, made in-process, private key
in the credential store, public key returned for the provider's form),
`create_password` (type `{{credential:<name>}}` in the browser),
`install_key` (password-only servers, through `SSH_ASKPASS`), `wait_ready`,
`harden` (updates, firewall, automatic security updates, key-only SSH when a
key is installed), `install_wireguard` (server config, device profiles and
QR codes under `media/vpn/<server>/`; re-running adds devices and keeps the
existing ones), `verify` (`ssh`, `wireguard` — with a real tunnel through a
temporary peer and network namespace when the machine allows it — or `url`),
`run`, `list_servers`, `record_server` (inventory in
`<ARTEMIS_HOME>/servers.json`). The QR encoder (`qr.ts`) matches a reference
encoder bit for bit; no external program is needed. `ARTEMIS_SSH_BIN`
replaces `ssh` (tests use `scripts/fixtures/fakeSsh.mjs`).

Secrets never reach a tool result or the history: results carry names,
public keys, file paths and check results.

## Credentials (`security/credentialStore.ts`)

`CredentialStore` with a file backend at `<ARTEMIS_HOME>/credentials`
(0700 dir, 0600 files; `ARTEMIS_CREDENTIALS_DIR` overrides). These are the
agent's own credentials for servers it manages, so they belong to the agent
user. A host can register another backend (`registerCredentialStore`) — the
place to plug the platform's vault in once the connector vault is merged.
`browser_type` / `browser_form_input` resolve `{{credential:<name>}}` just
before typing; an unknown name types nothing.

## Verification codes (`tools/verificationCodes.ts`)

`get_verification_code {channel: email|sms|which, sender?, timeoutSeconds?}`
uses `getVerificationCode(channel, sender, timeout)`: a registered
`VerificationCodeSource` or a host program in
`ARTEMIS_VERIFICATION_CODE_CMD` (prints `{"code": "…"}`). Without one it tells
the model to hand the step to the owner (takeover) or ask for the one-time
code — never a password. This is the adapter the agent mailbox/phone branch
plugs into.

## Tests

- `npm run test:copilot` (part of `test:runtime`): update limits and ids,
  history projection, status from tool activity, errand detection and
  routing, credentials and placeholders, key formats (checked with an
  independent OpenSSH parser when available), QR, `server_setup` against
  the fake SSH server (no secret in any output), codes adapter.
- `npm run eval:zh:mock`: the `errand` category (`evals/zh/README.md`) —
  golden VPN scenario, restaurant, deploy, and ten do-not-instruct requests,
  against an offline web and a fake SSH server.
