import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { resolveArtemisHomeDir } from '../utils/fs.js'

// ─── TYPES ───────────────────────────────────────────────────────────────────
export interface FreyaSessionState {
  messages: any[] // 
  astState: any // AST 状态
  taskContext: any // 
  assetRequest: any // 
}

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const SESSION_SUSPEND_FILE = path.join(resolveArtemisHomeDir(), 'session_suspend.json')

// ─── FREYA STATE MANAGER ─────────────────────────────────────────────────────

export class FreyaStateManager {
  /* */
  static async hasSuspendedSession(): Promise<boolean> {
    try {
      await fs.access(SESSION_SUSPEND_FILE)
      return true
    } catch {
      return false
    }
  }

  /* */
  static async suspendSession(context: FreyaSessionState): Promise<void> {
    try {
      // 
      await fs.mkdir(path.dirname(SESSION_SUSPEND_FILE), { recursive: true })
      
      // 
      await fs.writeFile(
        SESSION_SUSPEND_FILE,
        JSON.stringify(context, null, 2)
      )
      
      console.log('✅ Freya: 会话状态已成功挂起')
    } catch (error) {
      console.error('⚠️ Freya: 会话状态挂起失败:', error)
      throw error
    }
  }

  /* */
  static async resumeSession(): Promise<FreyaSessionState | null> {
    if (!await this.hasSuspendedSession()) {
      return null
    }

    try {
      // 
      const rawContent = await fs.readFile(SESSION_SUSPEND_FILE, 'utf8')
      const state: FreyaSessionState = JSON.parse(rawContent)
      
      // 
      await fs.unlink(SESSION_SUSPEND_FILE)
      
      // 
      const systemMessage = {
        role: 'system',
        content: 'System Action: User has successfully configured the visual API. Resume the previous task and proceed to generate the requested visual asset.'
      }
      
      state.messages = [systemMessage, ...(state.messages || [])]
      
      console.log('✅ Freya: 会话状态已成功恢复')
      return state
    } catch (error) {
      console.error('⚠️ Freya: 会话状态恢复失败:', error)
      
      // 
      try {
        await fs.unlink(SESSION_SUSPEND_FILE)
      } catch {
        // 
      }
      
      return null
    }
  }
}

// ─── DEFAULT EXPORTS ─────────────────────────────────────────────────────────
export default FreyaStateManager
