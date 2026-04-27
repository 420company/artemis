/**
 * utils/execFileNoThrow.ts — minimal subprocess helper stub
 * Minimal helper exported for termio/osc.ts.
 */

import { execFile } from 'node:child_process'

type ExecFileOptions = {
  abortSignal?: AbortSignal
  timeout?: number
  input?: string
  useCwd?: boolean
}

type ExecFileResult = {
  code: number
  stdout: string
  stderr: string
}

export async function execFileNoThrow(
  cmd: string,
  args: string[],
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return new Promise(resolve => {
    const child = execFile(cmd, args, { timeout: options.timeout ?? 30_000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
    if (options.input && child.stdin) {
      child.stdin.end(options.input)
    }
    options.abortSignal?.addEventListener('abort', () => child.kill(), { once: true })
  })
}
