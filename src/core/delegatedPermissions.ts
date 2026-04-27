import { getDelegatedPermissionMode } from './agentProfiles.js';
import { PermissionManager } from '../security/permissions.js';
import type { AgentPhase, AgentRole, PermissionMode } from './types.js';

export function getDelegatedChildPermissionMode(
  role: AgentRole,
  parentMode: PermissionMode,
  phase: AgentPhase = 'execution',
): PermissionMode {
  if (role === 'builder' && phase === 'proposal') {
    return 'read-only';
  }

  return getDelegatedPermissionMode(role, parentMode);
}

export function createDelegatedChildPermissionManager(
  parentPermissionManager: PermissionManager,
  role: AgentRole,
  phase: AgentPhase = 'execution',
): PermissionManager {
  return parentPermissionManager.fork(
    getDelegatedChildPermissionMode(
      role,
      parentPermissionManager.getMode(),
      phase,
    ),
  );
}
