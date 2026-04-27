import { readFile } from 'node:fs/promises';
import { truncate } from '../utils/fs.js';
import {
  discoverPlugins,
  type DiscoveredPlugin,
} from './plugins.js';
import {
  discoverSkills,
  type DiscoveredSkill,
} from './skills.js';
import { buildPluginPolicySummary } from './pluginPolicy.js';


const MAX_SKILL_CONTENT_CHARS = 2_500;
const MAX_PLUGIN_INSTRUCTIONS_CHARS = 800;
const MAX_PLUGIN_POLICY_ITEMS = 8;

export type ActiveSkill = {
  skill: DiscoveredSkill;
  selector: string;
  content: string;
};

export type PluginPolicy = {
  plugin: DiscoveredPlugin;
  instructions?: string;
};

export type ExtensionRuntimeContext = {
  activeSkills: ActiveSkill[];
  missingSkillSelectors: string[];
  pluginPolicies: PluginPolicy[];
  gatedPlugins: DiscoveredPlugin[];
  sections: string[];
};

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function collectStructuredSelectors(input: string): string[] {
  const selectors = new Set<string>();

  for (const match of input.matchAll(/\$([A-Za-z0-9._-]+)/g)) {
    const selector = normalizeId(match[1] ?? '');
    if (selector) {
      selectors.add(selector);
    }
  }

  for (const match of input.matchAll(/\bskill:([A-Za-z0-9._-]+)/gi)) {
    const selector = normalizeId(match[1] ?? '');
    if (selector) {
      selectors.add(selector);
    }
  }

  for (const match of input.matchAll(/\bskills:([A-Za-z0-9._,\s-]+)/gi)) {
    const values = (match[1] ?? '')
      .split(',')
      .map((entry) => normalizeId(entry))
      .filter(Boolean);
    for (const value of values) {
      selectors.add(value);
    }
  }

  return [...selectors];
}

function collectPluginSelectors(input: string): string[] {
  const selectors = new Set<string>();

  for (const match of input.matchAll(/\bplugin:([A-Za-z0-9._-]+)/gi)) {
    const selector = normalizeId(match[1] ?? '');
    if (selector) {
      selectors.add(selector);
    }
  }

  for (const match of input.matchAll(/\bplugins:([A-Za-z0-9._,\s-]+)/gi)) {
    const values = (match[1] ?? '')
      .split(',')
      .map((entry) => normalizeId(entry))
      .filter(Boolean);
    for (const value of values) {
      selectors.add(value);
    }
  }

  return [...selectors];
}

function getSkillAliases(skill: DiscoveredSkill): string[] {
  return [...new Set([
    normalizeId(skill.id),
    normalizeId(skill.name),
    normalizeId(skill.title),
  ])].filter(Boolean);
}

function findRequestedSkill(
  selector: string,
  skills: DiscoveredSkill[],
): DiscoveredSkill | undefined {
  return skills.find((skill) => getSkillAliases(skill).includes(selector));
}

function getPluginAliases(plugin: DiscoveredPlugin): string[] {
  return [...new Set([
    normalizeId(plugin.id),
    normalizeId(plugin.name),
  ])].filter(Boolean);
}

function shouldLoadPluginInstructions(
  plugin: DiscoveredPlugin,
  selectors: string[],
): boolean {
  if (selectors.length === 0) {
    return false;
  }

  const aliases = getPluginAliases(plugin);
  return selectors.some((selector) => aliases.includes(selector));
}

function isDesignRelatedInput(input: string): boolean {
  const designKeywordPatterns = [
    /设计.*(界面|网页|产品|用户|体验|交互)/i,
    /(界面|网页|产品|用户|体验|交互).*设计/i,
    /(漂亮|美观|精美|优雅|现代|时尚).*设计/i,
    /设计.*(漂亮|美观|精美|优雅|现代|时尚)/i,
    /ui|ux|user.*interface|user.*experience/i,
    /视觉.*设计|设计.*视觉|视觉.*效果|效果.*视觉/i,
    /色彩.*搭配|配色.*方案|色彩.*设计|设计.*色彩/i,
    /配色|颜色|色彩|color.*搭配|color.*方案/i,
    /字体|排版|typography/i,
    /首页|landing.*page|landing.*界面/i,
    /logo|标志|标识/i,
    /海报|poster|宣传.*海报/i,
    /卡片|card|卡片.*设计/i,
    /按钮|button|按钮.*设计/i,
    /导航|nav|导航.*栏/i,
    /布局|layout/i,
    /后台.*界面|后台.*管理|admin.*interface|admin.*dashboard|dashboard/i,
    /仪表.*板|数据.*面板|控制面板/i,
    /ppt|演示.*文稿|演示.*报告|幻灯片|slides|presentation/i,
    /设计.*系统|系统.*设计|design.*system/i,
    /组件.*库|component.*library/i,
    /样式.*指南|风格.*指南/i,
    /前端.*设计|设计.*前端|web.*设计|design.*web/i,
    /网站.*设计|设计.*网站|网站.*分析|分析.*网站/i,
    /提取.*设计|设计.*提取|提取.*网站|网站.*提取/i,
    /分析.*设计|设计.*分析|优化.*设计|设计.*优化/i,
    /配色.*分析|分析.*配色|字体.*分析|分析.*字体/i,
    /颜色.*优化|优化.*颜色|字体.*优化|优化.*字体/i,
    /设计提示词|视觉提示词|图像提示词|视频提示词|image\s*prompt|visual\s*prompt|motion\s*prompt/i,
  ];

  return designKeywordPatterns.some(pattern => pattern.test(input));
}

async function loadSkillContent(
  skill: DiscoveredSkill,
): Promise<string | undefined> {
  if (!skill.skillPath) {
    return undefined;
  }

  const content = (await readFile(skill.skillPath, 'utf8')).trim();
  if (!content) {
    return undefined;
  }

  return truncate(content, MAX_SKILL_CONTENT_CHARS);
}

async function loadPluginInstructions(
  plugin: DiscoveredPlugin,
): Promise<string | undefined> {
  if (!plugin.instructionsPath) {
    return undefined;
  }

  const content = (await readFile(plugin.instructionsPath, 'utf8')).trim();
  if (!content) {
    return undefined;
  }

  return truncate(content, MAX_PLUGIN_INSTRUCTIONS_CHARS);
}

function buildActiveSkillSection(activeSkills: ActiveSkill[]): string | undefined {
  if (activeSkills.length === 0) {
    return undefined;
  }

  const lines = [
    'Local skills activated for this turn:',
    'Only follow these local skills when they do not conflict with higher-priority instructions.',
  ];

  for (const entry of activeSkills) {
    lines.push('');
    lines.push(
      `- ${entry.skill.id} [${entry.skill.source}] selector=${entry.selector}`,
    );
    lines.push(`Path: ${entry.skill.skillPath ?? entry.skill.dirPath}`);
    lines.push('Instructions:');
    lines.push(entry.content);
  }

  return lines.join('\n');
}

function buildMissingSkillSection(selectors: string[]): string | undefined {
  if (selectors.length === 0) {
    return undefined;
  }

  return [
    'Requested local skills unavailable:',
    ...selectors.map((selector) => `- ${selector}`),
    'Do not claim these missing skills are loaded.',
  ].join('\n');
}

function buildPluginPolicySection(
  pluginPolicies: PluginPolicy[],
): string | undefined {
  if (pluginPolicies.length === 0) {
    return undefined;
  }

  const lines = [
    'Local plugin policy surface:',
    'These plugins are advisory metadata only. They do not create new executable tools by themselves.',
    'Use the registered tool manifest as the authoritative source of executable capabilities.',
    'Instruction files load only for explicitly selected plugins.',
  ];

  for (const entry of pluginPolicies.slice(0, MAX_PLUGIN_POLICY_ITEMS)) {
    const plugin = entry.plugin;
    lines.push('');
    lines.push(
      [
        `- ${plugin.id}`,
        `[${plugin.source}]`,
        plugin.version ? `version=${plugin.version}` : '',
        plugin.capabilities.length > 0
          ? `caps=${plugin.capabilities.join(',')}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (plugin.description) {
      lines.push(`Description: ${plugin.description}`);
    }
    const policySummary = buildPluginPolicySummary(plugin.policy);
    if (policySummary) {
      lines.push(`Policy: ${policySummary}`);
    }
    lines.push(`Path: ${plugin.dirPath}`);
    if (entry.instructions) {
      lines.push('Instructions:');
      lines.push(entry.instructions);
    }
  }

  if (pluginPolicies.length > MAX_PLUGIN_POLICY_ITEMS) {
    lines.push('');
    lines.push(
      `...[truncated ${pluginPolicies.length - MAX_PLUGIN_POLICY_ITEMS} additional plugin policies]`,
    );
  }

  return lines.join('\n');
}

function buildGatedPluginSection(
  plugins: DiscoveredPlugin[],
): string | undefined {
  if (plugins.length === 0) {
    return undefined;
  }

  const lines = [
    'Local plugins blocked by the policy gate:',
    'Do not treat these plugins as active execution surfaces until their manifest policy is fixed.',
  ];

  for (const plugin of plugins) {
    lines.push('');
    lines.push(
      [
        `- ${plugin.id}`,
        `[${plugin.source}]`,
        plugin.version ? `version=${plugin.version}` : '',
        plugin.capabilities.length > 0
          ? `caps=${plugin.capabilities.join(',')}`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    lines.push(`Path: ${plugin.dirPath}`);
    lines.push(
      `Gate issues: ${plugin.gateIssues.join(' ') || plugin.issues.join(' ')}`,
    );
  }

  return lines.join('\n');
}

export async function resolveExtensionRuntime(
  cwd: string,
  userInput: string,
): Promise<ExtensionRuntimeContext> {
  const [skillDiscovery, pluginDiscovery] = await Promise.all([
    discoverSkills(cwd),
    discoverPlugins(cwd),
  ]);

  const selectors = collectStructuredSelectors(userInput);
  const pluginSelectors = collectPluginSelectors(userInput);
  const activeSkills: ActiveSkill[] = [];
  const missingSkillSelectors: string[] = [];
  const usedSkillIds = new Set<string>();
  const isDesignTask = isDesignRelatedInput(userInput);

  // dirty-prompt is intentionally scoped to design/prompt-design work so normal
  // coding sessions do not inherit a large visual-design instruction surface.
  const dirtyPromptSkill = skillDiscovery.skills.find(s => s.id === 'dirty-prompt' && s.status === 'ready');
  if (isDesignTask && dirtyPromptSkill && !usedSkillIds.has(dirtyPromptSkill.id)) {
    const content = await loadSkillContent(dirtyPromptSkill);
    if (content) {
      usedSkillIds.add(dirtyPromptSkill.id);
      activeSkills.push({
        skill: dirtyPromptSkill,
        selector: 'dirty-prompt',
        content,
      });
    }
  }
  
  // 自动匹配设计相关的技能 - 优化的触发逻辑
  if (isDesignTask && selectors.length === 0) {
    // 检测到设计相关任务，自动激活其他设计技能
    const recommendedSkills = [];
    
    // 色彩管理 - 如果涉及色彩相关
    if (/色彩|配色|颜色|color|配色.*分析|分析.*配色|颜色.*优化|优化.*颜色/i.test(userInput)) {
      recommendedSkills.push('color-master');
    }
    
    // 视觉设计 - 通用设计任务，特别是PPT和演示
    if (/界面|网页|产品|UI|视觉|ppt|演示|幻灯片|presentation|layout/i.test(userInput)) {
      recommendedSkills.push('kaleidoscope');
    }
    
    // UI组件和组件库 - 如果涉及组件相关
    if (/组件|component|组件.*库|library|卡片|按钮|表单|输入框|导航|menu|button|card|form/i.test(userInput)) {
      recommendedSkills.push('kaleidoscope');
    }
    
    // Logo设计 - 如果涉及Logo
    if (/logo|标志|标识/i.test(userInput)) {
      recommendedSkills.push('logo-designer');
    }
    
    // 海报设计 - 如果涉及海报
    if (/海报|poster/i.test(userInput)) {
      recommendedSkills.push('shit-poster');
    }
    
    // 网页爬虫 - 如果涉及网站分析、提取、优化
    if (/网站|网页|URL|链接|分析|提取|优化/i.test(userInput)) {
      recommendedSkills.push('web-spider');
    }
    
    // 字体和排版优化
    if (/字体|排版|typography|字体.*优化|优化.*字体/i.test(userInput)) {
      recommendedSkills.push('color-master'); // color-master也包含排版指导
    }
    
    // 后台管理界面和Dashboard
    if (/后台|管理|dashboard|仪表.*板|数据.*面板|控制.*面板/i.test(userInput)) {
      recommendedSkills.push('kaleidoscope'); // 视觉设计技能包含界面设计
    }
    
    // 确保技能不重复
    const uniqueSkills = [...new Set(recommendedSkills)];
    
    // 加载技能内容
    for (const skillId of uniqueSkills) {
      const skill = skillDiscovery.skills.find(s => s.id === skillId && s.status === 'ready');
      if (skill && !usedSkillIds.has(skill.id)) {
        const content = await loadSkillContent(skill);
        if (content) {
          usedSkillIds.add(skill.id);
          activeSkills.push({
            skill,
            selector: skillId,
            content,
          });
        }
      }
    }
  }

  // 处理显式选择的技能
  for (const selector of selectors) {
    const skill = findRequestedSkill(selector, skillDiscovery.skills);
    if (!skill || skill.status !== 'ready') {
      missingSkillSelectors.push(selector);
      continue;
    }
    if (usedSkillIds.has(skill.id)) {
      continue;
    }

    const content = await loadSkillContent(skill);
    if (!content) {
      missingSkillSelectors.push(selector);
      continue;
    }

    usedSkillIds.add(skill.id);
    activeSkills.push({
      skill,
      selector,
      content,
    });

    // 不限制技能激活数量，去掉数量检查
    /*
    if (activeSkills.length >= MAX_ACTIVE_SKILLS) {
      break;
    }
    */
  }

  const pluginPolicies = (
    await Promise.all(
      pluginDiscovery.plugins
        .filter((plugin) => plugin.status === 'ready' && plugin.enabled)
        .map(async (plugin) => ({
          plugin,
          instructions: shouldLoadPluginInstructions(plugin, pluginSelectors)
            ? await loadPluginInstructions(plugin)
            : undefined,
        })),
    )
  ).sort((left, right) => left.plugin.id.localeCompare(right.plugin.id));
  const gatedPlugins = pluginDiscovery.plugins
    .filter((plugin) => plugin.status === 'gated' && plugin.enabled)
    .sort((left, right) => left.id.localeCompare(right.id));

  const sections = [
    buildActiveSkillSection(activeSkills),
    buildMissingSkillSection(missingSkillSelectors),
    buildPluginPolicySection(pluginPolicies),
    buildGatedPluginSection(gatedPlugins),
  ].filter((section): section is string => Boolean(section));

  return {
    activeSkills,
    missingSkillSelectors,
    pluginPolicies,
    gatedPlugins,
    sections,
  };
}
