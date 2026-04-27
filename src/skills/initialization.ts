import { SkillManager } from '../core/skillManager.js';
import type { SkillDefinition } from '../core/skillManager.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 基础技能定义
 */
const basicSkills: SkillDefinition[] = [
  {
    id: 'file_management',
    name: 'File Management',
    description: 'Basic file management operations',
    version: '1.0.0',
    author: 'Artemis Team',
    tags: ['file', 'management', 'basic', '文件', '管理'],
    entryPoint: 'tool_chain',
    inputs: [
      {
        name: 'directory',
        type: 'string',
        description: 'Directory to manage',
        required: true,
        default: '.',
      },
      {
        name: 'operation',
        type: 'string',
        enum: ['list', 'create', 'delete', 'copy', 'move'],
        description: 'Operation to perform',
        required: true,
        default: 'list',
      },
    ],
    outputs: [
      {
        name: 'result',
        type: 'object',
        description: 'Operation result',
      },
    ],
    dependencies: [],
    prerequisites: ['readDirectory', 'writeFile'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'system_info',
    name: 'System Information',
    description: 'Get system information and resources',
    version: '1.0.0',
    author: 'Artemis Team',
    tags: ['system', 'information', 'resources'],
    entryPoint: 'javascript',
    inputs: [
      {
        name: 'type',
        type: 'string',
        enum: ['basic', 'memory', 'cpu', 'network'],
        description: 'Type of system information',
        required: true,
        default: 'basic',
      },
    ],
    outputs: [
      {
        name: 'systemInfo',
        type: 'object',
        description: 'System information data',
      },
    ],
    dependencies: [],
    prerequisites: ['runCommand'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'text_analysis',
    name: 'Text Analysis',
    description: 'Basic text analysis capabilities',
    version: '1.0.0',
    author: 'Artemis Team',
    tags: ['text', 'analysis', 'processing'],
    entryPoint: 'javascript',
    inputs: [
      {
        name: 'text',
        type: 'string',
        description: 'Text to analyze',
        required: true,
      },
      {
        name: 'analysis',
        type: 'string',
        enum: ['word_count', 'sentiment', 'keywords'],
        description: 'Analysis type',
        required: true,
        default: 'word_count',
      },
    ],
    outputs: [
      {
        name: 'analysisResult',
        type: 'object',
        description: 'Analysis result',
      },
    ],
    dependencies: [],
    prerequisites: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

/**
 * 技能配置
 */
const skillConfigurations: Record<string, any> = {
  file_management: {
    toolChain: [
      {
        tool: 'readDirectory',
        input: {
          directory: '${inputs.directory}',
        },
        output: '${tool.output}',
      },
    ],
  },
  system_info: {
    code: `
const os = require('os');
const { execSync } = require('child_process');

function getSystemInfo(type) {
  const info = {};
  
  switch (type) {
    case 'basic':
      info.arch = os.arch();
      info.platform = os.platform();
      info.release = os.release();
      info.type = os.type();
      break;
      
    case 'memory':
      info.totalMem = os.totalmem();
      info.freeMem = os.freemem();
      info.usedMem = info.totalMem - info.freeMem;
      info.memoryUsage = {
        used: Math.round((info.usedMem / info.totalMem) * 100),
        free: Math.round((info.freeMem / info.totalMem) * 100),
      };
      break;
      
    case 'cpu':
      info.cpus = os.cpus();
      info.cpuCount = info.cpus.length;
      info.totalSpeed = info.cpus.reduce((sum, cpu) => sum + cpu.speed, 0);
      break;
      
    case 'network':
      info.interfaces = os.networkInterfaces();
      break;
  }
  
  return info;
}

return getSystemInfo(inputs.type);
    `,
  },
  text_analysis: {
    code: `
function analyzeText(text, analysisType) {
  const result = {};
  
  switch (analysisType) {
    case 'word_count':
      const words = text.trim().split(/\\s+/).filter(word => word.length > 0);
      const sentences = text.split(/[.!?]+/).filter(sentence => sentence.trim().length > 0);
      
      result.wordCount = words.length;
      result.sentenceCount = sentences.length;
      result.averageWordsPerSentence = Math.round(words.length / sentences.length);
      break;
      
    case 'keywords':
      const commonWords = ['the', 'and', 'is', 'are', 'in', 'to', 'of', 'for', 'on', 'with'];
      const wordCounts = {};
      
      text.toLowerCase()
        .replace(/[^a-zA-Z0-9\\s]/g, '')
        .split(/\\s+/)
        .filter(word => word.length > 2 && !commonWords.includes(word))
        .forEach(word => {
          wordCounts[word] = (wordCounts[word] || 0) + 1;
        });
      
      result.keywords = Object.entries(wordCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([word, count]) => ({ word, count }));
      break;
      
    case 'sentiment':
      const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful', 'perfect'];
      const negativeWords = ['bad', 'terrible', 'awful', 'horrible', 'disappointing'];
      
      let positiveCount = 0;
      let negativeCount = 0;
      
      text.toLowerCase()
        .replace(/[^a-zA-Z0-9\\s]/g, '')
        .split(/\\s+/)
        .forEach(word => {
          if (positiveWords.includes(word)) positiveCount++;
          if (negativeWords.includes(word)) negativeCount++;
        });
      
      result.sentiment = {
        positive: positiveCount,
        negative: negativeCount,
        score: positiveCount - negativeCount,
      };
      break;
  }
  
  return result;
}

return analyzeText(inputs.text, inputs.analysis);
    `,
  },
};

/**
 * 初始化技能系统
 */
export interface SkillSystemInitializationOptions {
  silent?: boolean;
}

export function initializeSkillSystem(
  skillManager: SkillManager = new SkillManager(),
  options: SkillSystemInitializationOptions = {}
): SkillDefinition[] {
  const initializedSkills = basicSkills.map(skill => ({ ...skill }));

  // loadSkillConfig also registers the skill definition, so include metadata with
  // the executable config to keep the registry valid for the caller's manager.
  initializedSkills.forEach(skill => {
    const config = skillConfigurations[skill.id];
    if (config) {
      void skillManager.loadSkillConfig(skill.id, {
        ...skill,
        ...config,
      });
    } else {
      skillManager.addSkillDefinition(skill);
    }
  });

  // 加载 skills 目录下的技能配置文件
  const skillsDirectory = path.resolve(__dirname, '../../skills');
  if (fs.existsSync(skillsDirectory)) {
    const skillFiles = fs.readdirSync(skillsDirectory)
      .filter(file => file.endsWith('.json'));
    
    for (const skillFile of skillFiles) {
      try {
        const skillPath = path.join(skillsDirectory, skillFile);
        const skillData = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
        
        // 加载技能配置
        void skillManager.loadSkillConfig(skillData.id, skillData);
        initializedSkills.push(skillData);
      } catch (error) {
        console.error(`Failed to load skill from ${skillFile}:`, error);
      }
    }
  }

  if (!options.silent) {
    console.log(`✅ 技能系统初始化完成 - 已加载 ${initializedSkills.length} 个技能（${basicSkills.length} 个基础技能 + ${initializedSkills.length - basicSkills.length} 个扩展技能）`);
  }

  return initializedSkills;
}
