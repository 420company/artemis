#!/usr/bin/env node
// A stand-in for `ssh` in tests and evals (ARTEMIS_SSH_BIN): no network.
// It reads the script server_setup sends on stdin, logs what was asked to
// ARTEMIS_SSH_FAKE_LOG (one JSON line per connection) and answers like a fresh
// Debian server would. Never prints secrets it receives.
//
//   ARTEMIS_SSH_FAKE_LOG             file to append the log to (optional)
//   ARTEMIS_SSH_FAKE_DOWN_FOR=N      refuse the first N connections ("still booting"); state in ARTEMIS_SSH_FAKE_STATE
//   ARTEMIS_SSH_FAKE_PASSWORD=…      the root password install_key must present (through SSH_ASKPASS)
//   ARTEMIS_SSH_FAKE_HOSTS=a,b       only these hosts exist (others: "No route to host")
//   ARTEMIS_SSH_FAKE_NEW_HOSTKEY=a,b these hosts answer with a changed host key (reinstalled, or someone in between)
//   ARTEMIS_SSH_FAKE_SSHD_OVERRIDE=1 a cloud image whose sshd config turns password login back on (hardening must fail)
//   ARTEMIS_SSH_FAKE_LOCKED=1        password logins are refused (key-only SSH already on)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const command = args.at(-1) ?? ''
const userHost = args.at(-2) ?? ''
const [user, host] = userHost.includes('@') ? userHost.split('@') : ['root', userHost]
const keyIndex = args.indexOf('-i')
const auth = keyIndex >= 0 ? 'key' : process.env.SSH_ASKPASS ? 'password' : 'none'

let script = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (script += d))
process.stdin.on('end', () => {
  const log = (entry) => {
    if (process.env.ARTEMIS_SSH_FAKE_LOG) appendFileSync(process.env.ARTEMIS_SSH_FAKE_LOG, JSON.stringify({ at: new Date().toISOString(), host, user, auth, command, ...entry }) + '\n')
  }
  const hosts = (process.env.ARTEMIS_SSH_FAKE_HOSTS ?? '').split(',').filter(Boolean)
  if (hosts.length && !hosts.includes(host)) {
    log({ result: 'no_route' })
    process.stderr.write(`ssh: connect to host ${host} port 22: No route to host\n`)
    process.exit(255)
  }
  if ((process.env.ARTEMIS_SSH_FAKE_NEW_HOSTKEY ?? '').split(',').includes(host)) {
    log({ result: 'hostkey_changed' })
    process.stderr.write('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n')
    process.exit(255)
  }
  const downFor = Number(process.env.ARTEMIS_SSH_FAKE_DOWN_FOR ?? 0)
  if (downFor > 0) {
    const state = process.env.ARTEMIS_SSH_FAKE_STATE ?? '/tmp/fake-ssh-state.json'
    const seen = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}
    seen[host] = (seen[host] ?? 0) + 1
    writeFileSync(state, JSON.stringify(seen))
    if (seen[host] <= downFor) {
      log({ result: 'refused' })
      process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`)
      process.exit(255)
    }
  }
  if (auth === 'password' && process.env.ARTEMIS_SSH_FAKE_LOCKED === '1') {
    log({ result: 'locked' })
    process.stderr.write(`${user}@${host}: Permission denied (publickey).\n`)
    process.exit(255)
  }
  if (auth === 'password') {
    let given = ''
    try {
      given = execFileSync(process.env.SSH_ASKPASS, ['password:'], { encoding: 'utf8' }).replace(/\n$/, '')
    } catch {
      given = ''
    }
    if (!process.env.ARTEMIS_SSH_FAKE_PASSWORD || given !== process.env.ARTEMIS_SSH_FAKE_PASSWORD) {
      log({ result: 'denied' })
      process.stderr.write(`${user}@${host}: Permission denied (publickey,password).\n`)
      process.exit(255)
    }
  } else if (auth !== 'key') {
    process.stderr.write(`${user}@${host}: Permission denied (publickey).\n`)
    process.exit(255)
  }
  const out = []
  const steps = []
  if (script.includes('ARTEMIS_STEP probe')) {
    out.push('os=Debian GNU/Linux 12 (bookworm)', 'kernel=6.1.0-25-amd64', 'arch=x86_64', 'virt=kvm', `ip=${host}`, 'ARTEMIS_STEP probe ok')
    steps.push('probe')
  }
  if (script.includes('ARTEMIS_STEP harden')) {
    if (process.env.ARTEMIS_SSH_FAKE_SSHD_OVERRIDE === '1' || !script.includes('00-agent-hardening.conf') || !script.includes('sshd -T')) {
      log({ steps: ['harden-failed'] })
      process.stdout.write('updates=done\nfirewall=ufw\n')
      process.stderr.write('key-only SSH is not in effect: another sshd setting turns password login back on\n')
      process.exit(3)
    }
    out.push('updates=done', 'firewall=ufw', ...(script.includes('wg show wg0 listening-port') ? ['vpn=kept (port 51820/udp)'] : []), 'ssh=key-only', 'ARTEMIS_STEP harden ok')
    steps.push('harden')
  }
  if (script.includes('ARTEMIS_STEP wireguard')) {
    const peers = (script.match(/^\[Peer\]$/gm) ?? []).length
    const port = /ListenPort = (\d+)/.exec(script)?.[1] ?? '51820'
    out.push(`listening=${port}`, 'ARTEMIS_STEP wireguard ok')
    steps.push('wireguard')
    log({ peers, port })
  }
  if (script.includes('ARTEMIS_STEP check')) {
    out.push('service=active', `listening=${/expected (\d+)/.exec(script)?.[1] ?? '51820'}`, 'peers=2', 'forwarding=1', 'ARTEMIS_STEP check ok')
    steps.push('check')
  }
  if (script.includes('ARTEMIS_STEP install_key')) {
    out.push('ARTEMIS_STEP install_key ok')
    steps.push('install_key')
  }
  if (script.includes('ARTEMIS_STEP cleanup')) {
    out.push('ARTEMIS_STEP cleanup ok')
    steps.push('cleanup')
  }
  if (steps.length === 0) out.push(`ran: ${script.trim().slice(0, 200)}`)
  log({ steps, scriptHasPrivateKey: /PrivateKey = \S/.test(script) || /BEGIN OPENSSH/.test(script), ipv6Forwarding: /ipv6\.conf\.all\.forwarding=1/.test(script), keepsVpn: /wg show wg0 listening-port/.test(script) && script.includes('ARTEMIS_STEP harden') })
  process.stdout.write(out.join('\n') + '\n')
  process.exit(0)
})
