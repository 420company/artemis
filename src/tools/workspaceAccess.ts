import path from 'node:path'
import type { ToolExecutionContext, WorkspaceSwitchRequest } from './types.js'
import { fromHeimdallVirtualPath } from '../core/heimdall.js'
import {
  isPathInsideWorkspace,
  resolveWorkspaceCandidatePath,
  resolveWorkspaceForTargetPath,
} from '../utils/workspaceRoots.js'
import { resolveInsideRoot } from '../utils/fs.js'

function normalizeToolInputPath(
  inputPath: string,
  context: ToolExecutionContext,
): string {
  if (inputPath.startsWith('/mnt/user-data/')) {
    return fromHeimdallVirtualPath(context.cwd, inputPath, context.sessionId)
  }
  return inputPath
}

export function resolveAbsoluteToolCandidate(
  inputPath: string,
  baseCwd: string,
  context: ToolExecutionContext,
): string {
  const normalizedInput = normalizeToolInputPath(inputPath, context)
  return resolveWorkspaceCandidatePath(normalizedInput, baseCwd)
}

export async function ensureWorkspaceForToolCandidate(options: {
  candidatePath: string
  inputPath: string
  toolName: string
  context: ToolExecutionContext
  baseCwd?: string
  switchNow?: boolean
}): Promise<string> {
  const {
    candidatePath,
    inputPath,
    toolName,
    context,
    baseCwd = context.cwd,
    switchNow = true,
  } = options

  if (isPathInsideWorkspace(baseCwd, candidatePath)) {
    return baseCwd
  }

  const resolution = await resolveWorkspaceForTargetPath(candidatePath, baseCwd)
  if (!resolution) {
    throw new Error(`Path escapes working directory: ${inputPath}`)
  }

  const request: WorkspaceSwitchRequest = {
    requestedPath: resolution.requestedPath,
    workspacePath: resolution.workspacePath,
    usedNearestExistingParent: resolution.usedNearestExistingParent,
    source: toolName === 'run_command' ? 'run_command' : 'tool-path',
    toolName,
    originalPath: inputPath,
    switchNow,
  }

  if (!(await context.requestWorkspaceSwitch?.(request))) {
    throw new Error(
      switchNow
        ? `Workspace switch declined for ${inputPath}.`
        : `Workspace trust declined for ${inputPath}.`,
    )
  }

  if (switchNow && resolution.workspacePath !== baseCwd) {
    await Promise.resolve(context.updateCwd?.(resolution.workspacePath))
  }

  return switchNow ? resolution.workspacePath : baseCwd
}

export async function resolveToolPathWithWorkspaceAccess(options: {
  inputPath: string
  toolName: string
  context: ToolExecutionContext
  baseCwd?: string
}): Promise<{
  absolute: string
  cwd: string
  displayPath: string
}> {
  const { inputPath, toolName, context, baseCwd = context.cwd } = options
  const candidatePath = resolveAbsoluteToolCandidate(inputPath, baseCwd, context)
  const effectiveCwd = await ensureWorkspaceForToolCandidate({
    candidatePath,
    inputPath,
    toolName,
    context,
    baseCwd,
    switchNow: true,
  })
  const absolute = resolveInsideRoot(effectiveCwd, candidatePath)

  return {
    absolute,
    cwd: effectiveCwd,
    displayPath: path.relative(effectiveCwd, absolute) || path.basename(absolute),
  }
}
