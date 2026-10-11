/**
 * tools/verificationCodes.ts — `get_verification_code`: the one-time code a
 * sign-up or login sends by email or SMS, fetched by the agent itself when
 * the host gives it a mailbox or phone number, so the user does not have to.
 *
 * Adapter: the host registers a VerificationCodeSource
 * (registerVerificationCodeSource), or names a program in
 * ARTEMIS_VERIFICATION_CODE_CMD that prints `{"code":"123456","from":"…"}`
 * for `--channel email|sms --sender <text> --timeout <seconds> --since <ISO>`
 * (exit 0; exit 2 or `{}` when nothing arrived). Without either, the tool
 * says so and the agent falls back to a browser takeover or asks the user.
 */

import { spawn } from 'node:child_process';

export type CodeChannel = 'email' | 'sms';

export interface CodeRequest {
  channel: CodeChannel;
  /** Who sends it ("Vultr", "noreply@example.com"): narrows the search. */
  sender?: string;
  timeoutMs: number;
  /** Only codes that arrived after this time. */
  since: Date;
  signal?: AbortSignal;
}

export interface ReceivedCode {
  code: string;
  from?: string;
  receivedAt?: string;
}

export interface VerificationCodeSource {
  /** Which channels this source can read, and the address/number to give a site. */
  channels(): Promise<Partial<Record<CodeChannel, string>>>;
  get(request: CodeRequest): Promise<ReceivedCode | undefined>;
}

let registered: VerificationCodeSource | undefined;

export function registerVerificationCodeSource(source: VerificationCodeSource | undefined): void {
  registered = source;
}

/** A source backed by a host program (ARTEMIS_VERIFICATION_CODE_CMD). */
export function commandCodeSource(command: string): VerificationCodeSource {
  const run = (args: string[], timeoutMs: number, signal?: AbortSignal) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5_000);
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (d: Buffer) => (out = (out + d.toString()).slice(-10_000)));
      const end = (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, out });
      };
      child.on('error', () => end(127));
      child.on('close', end);
    });
  return {
    async channels() {
      const r = await run(['--channels'], 10_000);
      try {
        const parsed = JSON.parse(r.out.trim() || '{}') as Record<string, unknown>;
        const out: Partial<Record<CodeChannel, string>> = {};
        if (typeof parsed.email === 'string') out.email = parsed.email;
        if (typeof parsed.sms === 'string') out.sms = parsed.sms;
        return out;
      } catch {
        return {};
      }
    },
    async get(request) {
      const r = await run(
        ['--channel', request.channel, ...(request.sender ? ['--sender', request.sender] : []), '--timeout', String(Math.ceil(request.timeoutMs / 1000)), '--since', request.since.toISOString()],
        request.timeoutMs,
        request.signal,
      );
      if (r.code !== 0) return undefined;
      try {
        const parsed = JSON.parse(r.out.trim() || '{}') as Record<string, unknown>;
        const code = typeof parsed.code === 'string' ? parsed.code.trim() : '';
        if (!/^[A-Za-z0-9-]{3,12}$/.test(code)) return undefined;
        return { code, ...(typeof parsed.from === 'string' ? { from: parsed.from.slice(0, 200) } : {}), ...(typeof parsed.receivedAt === 'string' ? { receivedAt: parsed.receivedAt } : {}) };
      } catch {
        return undefined;
      }
    },
  };
}

export function currentCodeSource(): VerificationCodeSource | undefined {
  if (registered) return registered;
  const command = process.env.ARTEMIS_VERIFICATION_CODE_CMD?.trim();
  return command ? commandCodeSource(command) : undefined;
}

export interface GetCodeAction {
  type: 'get_verification_code';
  channel?: CodeChannel | 'which';
  sender?: string;
  timeoutSeconds?: number;
}

/** getVerificationCode(channel, sender, timeout): the adapter the sign-up flow uses. */
export async function getVerificationCode(channel: CodeChannel, sender: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ReceivedCode | undefined> {
  const source = currentCodeSource();
  if (!source) return undefined;
  return source.get({ channel, ...(sender ? { sender } : {}), timeoutMs, since: new Date(Date.now() - 10 * 60_000), ...(signal ? { signal } : {}) });
}

export async function executeGetVerificationCode(action: GetCodeAction, context: { abortSignal?: AbortSignal }): Promise<{ action: GetCodeAction; ok: boolean; output: string; error?: { code: string; message: string; retryable?: boolean } }> {
  const source = currentCodeSource();
  const fallback = 'No mailbox or phone number of your own is connected. Ask the user to take over the browser and type the code (browser_request_handoff), or to send you the one-time code in chat — never their password.';
  if (!source) return { action, ok: false, output: fallback, error: { code: 'codes_unavailable', message: fallback, retryable: false } };
  if (!action.channel || action.channel === 'which') {
    const channels = await source.channels();
    const lines = Object.entries(channels).map(([k, v]) => `${k}: ${v}`);
    return lines.length
      ? { action, ok: true, output: `You can receive codes at:\n${lines.join('\n')}\nUse these for sign-ups when the user agreed to it, then call get_verification_code with that channel.` }
      : { action, ok: false, output: fallback, error: { code: 'codes_unavailable', message: fallback, retryable: false } };
  }
  const timeoutMs = Math.max(15, Math.min(600, action.timeoutSeconds ?? 120)) * 1000;
  const received = await getVerificationCode(action.channel, action.sender?.slice(0, 120), timeoutMs, context.abortSignal);
  if (!received) {
    const message = `No ${action.channel === 'sms' ? 'SMS' : 'email'} code arrived within ${Math.round(timeoutMs / 1000)} s. Ask the site to resend once; if it still does not come, hand the step to the user.`;
    return { action, ok: false, output: message, error: { code: 'code_not_received', message, retryable: true } };
  }
  return { action, ok: true, output: `Code: ${received.code}${received.from ? ` (from ${received.from})` : ''}. Type it where the site asks; it is single-use.` };
}
