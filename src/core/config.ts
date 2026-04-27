/**
 * Artemis 配置模块
 * 统一管理项目配置
 */

import * as fs from 'fs';
import * as path from 'path';

// 配置目录
const configDir = path.join(process.cwd(), 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

export interface ArtemisConfig {
  // 服务器配置
  port: number;
  host: string;
  nodeEnv: string;
  
  // OpenAI 配置
  openaiApiKey: string;
  openaiModel: string;
  openaiEndpoint: string;
  
  // Anthropic 配置
  anthropicApiKey: string;
  anthropicModel: string;
  
  // 数据库配置
  databaseUrl: string;
  
  // 安全配置
  jwtSecret: string;
  apiKey: string;
  
  // 日志配置
  logLevel: string;
  logFormat: string;
  
  // 性能配置
  clusterMode: boolean;
  workerCount: number;
  maxMemory: number;
  
  // 缓存配置
  redisUrl?: string;
  cacheEnabled: boolean;
  cacheTtl: number;
  
  // 监控配置
  prometheusEnabled: boolean;
  prometheusPort: number;
  
  // 开发配置
  debugMode: boolean;
  corsEnabled: boolean;
  corsOrigin: string;
}

// 默认配置
const defaultConfig: ArtemisConfig = {
  port: 3000,
  host: '0.0.0.0',
  nodeEnv: 'development',
  
  openaiApiKey: '',
  openaiModel: 'gpt-4o',
  openaiEndpoint: 'https://api.openai.com/v1',
  
  anthropicApiKey: '',
  anthropicModel: 'claude-3-sonnet-20240229',
  
  databaseUrl: 'sqlite:./artemis.db',
  
  jwtSecret: '',
  apiKey: '',
  
  logLevel: 'info',
  logFormat: 'json',
  
  clusterMode: true,
  workerCount: 0, // 0 表示使用所有 CPU 核心
  maxMemory: 4096, // MB
  
  cacheEnabled: true,
  cacheTtl: 300, // 秒
  
  prometheusEnabled: true,
  prometheusPort: 9090,
  
  debugMode: false,
  corsEnabled: true,
  corsOrigin: '*'
};

// 从环境变量读取配置
function getConfigFromEnvironment(): Partial<ArtemisConfig> {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    openaiEndpoint: process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1',
    
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-3-sonnet-20240229',
    
    databaseUrl: process.env.DATABASE_URL || 'sqlite:./artemis.db',
    
    jwtSecret: process.env.JWT_SECRET || '',
    apiKey: process.env.API_KEY || '',
    
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || 'json',
    
    clusterMode: process.env.CLUSTER_MODE !== 'false',
    workerCount: parseInt(process.env.WORKER_COUNT || '0', 10),
    maxMemory: parseInt(process.env.MAX_MEMORY || '4096', 10),
    
    cacheEnabled: process.env.CACHE_ENABLED !== 'false',
    cacheTtl: parseInt(process.env.CACHE_TTL || '300', 10),
    
    prometheusEnabled: process.env.PROMETHEUS_ENABLED !== 'false',
    prometheusPort: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),
    
    debugMode: process.env.DEBUG_MODE === 'true',
    corsEnabled: process.env.CORS_ENABLED !== 'false',
    corsOrigin: process.env.CORS_ORIGIN || '*'
  };
}

// 从文件读取配置
function getConfigFromFile(): Partial<ArtemisConfig> {
  const configPaths = [
    path.join(configDir, 'config.json'),
    path.join(process.cwd(), 'config.json'),
    path.join(process.cwd(), 'config.js')
  ];
  
  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(configData);
      } catch (error) {
        console.error('读取配置文件失败:', error);
      }
    }
  }
  
  return {};
}

// 合并配置
function mergeConfigs(): ArtemisConfig {
  const environmentConfig = getConfigFromEnvironment();
  const fileConfig = getConfigFromFile();
  
  return {
    ...defaultConfig,
    ...fileConfig,
    ...environmentConfig
  };
}

// 配置实例
const config = mergeConfigs();

// 验证配置
function validateConfig(): void {
  const requiredFields = [
    'port',
    'host',
    'nodeEnv',
    'jwtSecret',
    'apiKey',
    'databaseUrl'
  ];
  
  const missingFields = requiredFields.filter(field => 
    !config[field as keyof ArtemisConfig]
  );
  
  if (missingFields.length > 0) {
    throw new Error(`缺少必要配置字段: ${missingFields.join(', ')}`);
  }
  
  if (config.port < 1 || config.port > 65535) {
    throw new Error(`端口号无效: ${config.port}`);
  }
  
  if (config.workerCount < 0) {
    throw new Error(`工作进程数无效: ${config.workerCount}`);
  }
  
  if (config.maxMemory <= 0) {
    throw new Error(`最大内存限制无效: ${config.maxMemory}`);
  }
  
  if (config.cacheTtl <= 0) {
    throw new Error(`缓存过期时间无效: ${config.cacheTtl}`);
  }
}

// 应用配置
function applyConfig(): void {
  // 设置环境变量
  process.env.NODE_ENV = config.nodeEnv;
}

// 保存配置到文件
function saveConfig(newConfig: Partial<ArtemisConfig>): void {
  const mergedConfig = { ...config, ...newConfig };
  const configPath = path.join(configDir, 'config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2));
    console.log('配置已保存');
  } catch (error) {
    console.error('保存配置失败:', error);
  }
}

// 导出配置
export {
  config,
  validateConfig,
  applyConfig,
  saveConfig,
  mergeConfigs
};