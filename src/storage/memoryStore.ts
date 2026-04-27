import { join, dirname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { ensureDir, resolveDataRootDir } from '../utils/fs.js'

export interface GlobalInsight {
  content: string
  category: 'preference' | 'skill' | 'architecture'
  createdAt: string
}

export class MemoryStore {
  private memoryPath: string

  constructor(cwd: string) {
    const root = resolveDataRootDir(cwd)
    this.memoryPath = join(root, 'memory.json')
  }

  async load(): Promise<GlobalInsight[]> {
    try {
      const data = await readFile(this.memoryPath, 'utf-8')
      return JSON.parse(data) as GlobalInsight[]
    } catch {
      return []
    }
  }

  async save(insights: GlobalInsight[]): Promise<void> {
    await ensureDir(dirname(this.memoryPath))
    await writeFile(this.memoryPath, JSON.stringify(insights, null, 2), 'utf-8')
  }

  async addInsights(newInsights: Omit<GlobalInsight, 'createdAt'>[]): Promise<void> {
    const existing = await this.load()
    const toAdd = newInsights.map(i => ({ ...i, createdAt: new Date().toISOString() }))
    
    // De-duplicate naive exact matches (case-insensitive deduplication)
    const dedupedToAdd = toAdd.filter(
      (ni) => !existing.some((ei) => ei.content.toLowerCase().trim() === ni.content.toLowerCase().trim())
    )

    if (dedupedToAdd.length === 0) return

    // Prepend new insights to the front and cap at maximum 30 to preserve Token efficiency
    const combined = [...dedupedToAdd, ...existing].slice(0, 30)
    await this.save(combined)
  }
}
