/* eslint-disable @typescript-eslint/no-unused-vars */
import type { SkillDefinition, SkillExecutionResult } from '../../core/skillManager.js';
import { ToolDefinition } from '../../core/toolDef';

/**
 * 技能管理工具定义
 */
export const skillToolDef: ToolDefinition = {
  type: 'manage_skills',
  description: 'Manage skills - list, create, update, and execute skills',
  kind: 'agent',
  executionMode: 'blocking',
  permissionCategory: 'agent',
  parallelSafe: true,
  validate: (action: any) => {
    const errors: string[] = [];
    if (!action?.action) {
      errors.push('Missing action');
    } else if (!['list', 'info', 'execute', 'create', 'update', 'delete', 'validate'].includes(action.action)) {
      errors.push('Invalid action');
    }
    if (['info', 'execute', 'update', 'delete', 'validate'].includes(action.action) && !action.skillId) {
      errors.push('Skill ID is required');
    }
    if (['create', 'update'].includes(action.action) && !action.parameters?.definition) {
      errors.push('Skill definition is required');
    }
    if (action.action === 'execute' && !action.parameters?.inputs) {
      errors.push('Inputs are required');
    }
    return errors;
  },
  execute: async (action: any, context: any): Promise<{ ok: boolean; output: string }> => {
    try {
      switch (action.action) {
        case 'list':
          return await listSkills(action, context);
        case 'info':
          return await getSkillInfo(action, context);
        case 'execute':
          return await executeSkill(action, context);
        case 'create':
          return await createSkill(action, context);
        case 'update':
          return await updateSkill(action, context);
        case 'delete':
          return await deleteSkill(action, context);
        case 'validate':
          return await validateSkill(action, context);
        default:
          return {
            ok: false,
            output: `Unknown action: ${action.action}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

/**
 * 列出所有技能
 */
async function listSkills(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  const skills = skillManager.getAllSkillDefinitions();
  
  if (skills.length === 0) {
    return {
      ok: true,
      output: 'No skills available',
    };
  }

  const skillList = skills.map((skill, index) => {
    return `${index + 1}. ${skill.name} (${skill.id})
   Version: ${skill.version}
   Author: ${skill.author || 'Unknown'}
   Description: ${skill.description}
   Tags: ${skill.tags?.join(', ') || 'None'}
   Inputs: ${skill.inputs?.length || 0}
   Outputs: ${skill.outputs?.length || 0}`;
  }).join('\n\n');

  return {
    ok: true,
    output: `Skills (${skills.length}):\n\n${skillList}`,
  };
}

/**
 * 获取技能信息
 */
async function getSkillInfo(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.skillId) {
    return {
      ok: false,
      output: 'Skill ID is required',
    };
  }

  const skill = skillManager.getSkillDefinition(action.skillId);
  if (!skill) {
    return {
      ok: false,
      output: `Skill not found: ${action.skillId}`,
    };
  }

  const inputs = skill.inputs?.map((input) => {
    return `  - ${input.name} (${input.type})${input.required ? ' (required)' : ''}
      Description: ${input.description}
      Default: ${JSON.stringify(input.default)}`;
  }).join('\n') || '  None';

  const outputs = skill.outputs?.map((output) => {
    return `  - ${output.name} (${output.type})
      Description: ${output.description}`;
  }).join('\n') || '  None';

  const dependencies = skill.dependencies?.map((dep) => `  - ${dep}`).join('\n') || '  None';

  return {
    ok: true,
    output: `Skill Information:
  Name: ${skill.name}
  ID: ${skill.id}
  Version: ${skill.version}
  Author: ${skill.author || 'Unknown'}
  Description: ${skill.description}
  Tags: ${skill.tags?.join(', ') || 'None'}
  Entry Point: ${skill.entryPoint}
  
  Inputs:
${inputs}

  Outputs:
${outputs}

  Dependencies:
${dependencies}

  Prerequisites:
  ${skill.prerequisites?.map((prereq) => `  - ${prereq}`).join('\n') || '  None'}

  Created: ${skill.createdAt}
  Updated: ${skill.updatedAt}`,
  };
}

/**
 * 执行技能
 */
async function executeSkill(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.skillId) {
    return {
      ok: false,
      output: 'Skill ID is required',
    };
  }

  if (!action.parameters?.inputs) {
    return {
      ok: false,
      output: 'Inputs are required',
    };
  }

  const result = await skillManager.executeSkill(action.skillId, action.parameters.inputs, {
    cwd: context.cwd || context.workingDirectory,
    workingDirectory: context.cwd || context.workingDirectory,
    environmentVariables: context.environmentVariables,
    tools: context.tools,
    logger: context.logger,
  });

  if (!result.success) {
    return {
      ok: false,
      output: result.error || 'Execution failed',
    };
  }

  const logs = result.logs?.map((log) => `  - ${log}`).join('\n') || '';

  return {
    ok: true,
    output: `Execution Successful!
  Duration: ${result.duration}ms
${logs ? `
  Logs:
${logs}` : ''}
${result.output ? `
  Output:
${JSON.stringify(result.output, null, 2)}` : ''}`,
  };
}

/**
 * 创建技能
 */
async function createSkill(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.parameters?.definition) {
    return {
      ok: false,
      output: 'Skill definition is required',
    };
  }

  const definition = action.parameters.definition;
  
  // 验证必要字段
  if (!definition.id || !definition.name || !definition.description || !definition.version) {
    return {
      ok: false,
      output: 'Required fields: id, name, description, version',
    };
  }

  // 检查技能是否已存在
  if (skillManager.getSkillDefinition(definition.id)) {
    return {
      ok: false,
      output: `Skill already exists: ${definition.id}`,
    };
  }

  const skillDefinition = {
    ...definition,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  skillManager.addSkillDefinition(skillDefinition);

  // 保存技能配置
  if (action.parameters?.config) {
    skillManager.loadSkillConfig(definition.id, action.parameters.config);
  }

  return {
    ok: true,
    output: `Skill created successfully: ${definition.name} (${definition.id})`,
  };
}

/**
 * 更新技能
 */
async function updateSkill(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.skillId) {
    return {
      ok: false,
      output: 'Skill ID is required',
    };
  }

  if (!action.parameters?.definition) {
    return {
      ok: false,
      output: 'Skill definition is required',
    };
  }

  const existingSkill = skillManager.getSkillDefinition(action.skillId);
  if (!existingSkill) {
    return {
      ok: false,
      output: `Skill not found: ${action.skillId}`,
    };
  }

  const skillDefinition = {
    ...existingSkill,
    ...action.parameters.definition,
    updatedAt: new Date().toISOString(),
  };

  skillManager.addSkillDefinition(skillDefinition);

  // 更新技能配置
  if (action.parameters?.config) {
    skillManager.loadSkillConfig(action.skillId, action.parameters.config);
  }

  return {
    ok: true,
    output: `Skill updated successfully: ${skillDefinition.name} (${skillDefinition.id})`,
  };
}

/**
 * 删除技能
 */
async function deleteSkill(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.skillId) {
    return {
      ok: false,
      output: 'Skill ID is required',
    };
  }

  const skill = skillManager.getSkillDefinition(action.skillId);
  if (!skill) {
    return {
      ok: false,
      output: `Skill not found: ${action.skillId}`,
    };
  }

  // 这里应该从地图中删除技能
  // 由于 skillManager 目前没有删除方法，我们需要添加它
  // 临时解决方案：我们可以创建一个新地图
  // 实际项目中，应该在 skillManager 中添加删除方法

  return {
    ok: false,
    output: 'Delete operation not implemented yet',
  };
}

/**
 * 验证技能
 */
async function validateSkill(action: any, context: any): Promise<{ ok: boolean; output: string }> {
  const { SkillManager } = await import('../../core/skillManager.js');
  const skillManager = new SkillManager();
  
  if (!action.skillId) {
    return {
      ok: false,
      output: 'Skill ID is required',
    };
  }

  try {
    const missingDependencies = skillManager.validateDependencies(action.skillId);
    
    if (missingDependencies.length === 0) {
      return {
        ok: true,
        output: 'Skill validation passed: all dependencies are satisfied',
      };
    } else {
      return {
        ok: false,
        output: `Skill validation failed: missing dependencies - ${missingDependencies.join(', ')}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      output: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}