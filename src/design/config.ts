// 设计系统配置
// 包含系统参数、默认设置和扩展性配置

import { DEFAULT_AGENT_MAX_TURNS } from '../cli/branding.js';

// 设计系统配置接口
export interface DesignSystemConfig {
  // 基础配置
  version: string;
  name: string;
  description: string;
  
  // 风格配置
  defaultStyle: string;
  supportedStyles: string[];
  
  // 生成配置
  defaultGeneratorOptions: GeneratorOptions;
  
  // 匹配配置
  defaultMatcherOptions: MatcherOptions;
  
  // 执行配置
  defaultExecutionOptions: ExecutionOptions;
  
  // 可视化配置
  visualizationOptions: VisualizationOptions;
  
  // 扩展性配置
  extensions: ExtensionConfig;
}

// 生成器选项
export interface GeneratorOptions {
  includeColors: boolean;
  includeTypography: boolean;
  includeLayout: boolean;
  includeComponents: boolean;
  includeExamples: boolean;
  responsiveDesign: boolean;
  accessibility: boolean;
}

// 匹配器选项
export interface MatcherOptions {
  minScore: number;
  maxResults: number;
  considerProductType: boolean;
  considerTargetAudience: boolean;
  considerKeyFeatures: boolean;
}

// 执行选项
export interface ExecutionOptions {
  maxTurns: number;
  permissionMode: string;
  appendUserMessage: boolean;
  completionContract: string;
}

// 可视化选项
export interface VisualizationOptions {
  colorPaletteSize: number;
  showTypographyExamples: boolean;
  showLayoutExamples: boolean;
  showComponentExamples: boolean;
  showCodeExamples: boolean;
  interactivePreview: boolean;
}

// 扩展配置
export interface ExtensionConfig {
  enabled: boolean;
  plugins: string[];
  customGenerators: string[];
  customMatchers: string[];
  customStyles: string[];
}

// 默认配置
export const DEFAULT_CONFIG: DesignSystemConfig = {
  version: '1.1.0',
  name: 'Artemis Design System',
  description: 'A comprehensive layered prompt and design execution system for Artemis applications',
  
  defaultStyle: 'minimalism',
  supportedStyles: [
    'minimalism',
    'maximalism',
    'constructivism',
    'deconstructivism',
    'neo-expressionism',
    'neoclassicism',
    'neo-futurism',
    'neo-brutalism',
    'surrealism',
    'bauhaus',
    'biomorphic',
    'art-deco',
    'memphis',
    'neo-pop',
    'glitch',
    'collage',
    'op-art',
    'conceptual',
    'acid',
    'color-field',
    'naive',
    'steampunk',
    'atompunk',
    'cyberpunk',
    'wasteland-punk',
    'vaporwave',
    'y2k',
    'solarpunk',
    'kidcore',
    'dreamcore',
  ],
  
  defaultGeneratorOptions: {
    includeColors: true,
    includeTypography: true,
    includeLayout: true,
    includeComponents: true,
    includeExamples: true,
    responsiveDesign: true,
    accessibility: true,
  },
  
  defaultMatcherOptions: {
    minScore: 10,
    maxResults: 5,
    considerProductType: true,
    considerTargetAudience: true,
    considerKeyFeatures: true,
  },
  
  defaultExecutionOptions: {
    maxTurns: DEFAULT_AGENT_MAX_TURNS,
    permissionMode: 'WRITER',
    appendUserMessage: true,
    completionContract: 'requires_execution_evidence',
  },
  
  visualizationOptions: {
    colorPaletteSize: 6,
    showTypographyExamples: true,
    showLayoutExamples: true,
    showComponentExamples: true,
    showCodeExamples: true,
    interactivePreview: true,
  },
  
  extensions: {
    enabled: true,
    plugins: [
      'logo-designer',
      'kaleidoscope',
      'shit-poster',
      'dirty-prompt',
      'color-master',
      'web-spider',
    ],
    customGenerators: [],
    customMatchers: [],
    customStyles: [],
  },
};

// 配置管理器
export class DesignSystemConfigManager {
  private config: DesignSystemConfig;
  
  constructor(config: Partial<DesignSystemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  // 获取配置
  get(): DesignSystemConfig {
    return { ...this.config };
  }
  
  // 更新配置
  update(config: Partial<DesignSystemConfig>): void {
    this.config = { ...this.config, ...config };
  }
  
  // 获取配置项
  getOption<T = any>(path: string): T {
    const parts = path.split('.');
    let value: any = this.config;
    
    for (const part of parts) {
      if (value[part] !== undefined) {
        value = value[part];
      } else {
        return undefined as any;
      }
    }
    
    return value;
  }
  
  // 设置配置项
  setOption<T = any>(path: string, value: T): void {
    const parts = path.split('.');
    let obj: any = this.config;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!obj[part]) {
        obj[part] = {};
      }
      obj = obj[part];
    }
    
    obj[parts[parts.length - 1]] = value;
  }
  
  // 保存配置
  save(): string {
    return JSON.stringify(this.config, null, 2);
  }
  
  // 加载配置
  load(json: string): void {
    try {
      const config = JSON.parse(json);
      this.config = { ...DEFAULT_CONFIG, ...config };
    } catch (error) {
      console.error('Failed to load design system configuration:', error);
    }
  }
}

// 全局配置实例
export const designSystemConfig = new DesignSystemConfigManager();
