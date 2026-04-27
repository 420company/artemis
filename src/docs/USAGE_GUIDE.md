# Artemis 使用指南

## 简介

Artemis 是一个强大的 AI 辅助编程工具，基于 Google AI ADK 架构，提供完整的代理系统、工具管理、技能执行和会话管理功能。

## 快速开始

### 安装

```bash
npm install artemis
```

### 基本使用

```typescript
import { AgentManager, ToolManager, SessionManager, 
         streamManager, skillManager, SecurityManager } from 'artemis';
import { AgentFactory } from 'artemis/core/adk/agent_factory';

// 创建管理器实例
const agentManager = new AgentManager();
const toolManager = new ToolManager();
const sessionManager = new SessionManager();

// 创建基础 LLM 代理
const baseAgent = AgentFactory.createDefaultLlmAgent(
  'base_agent',
  '基础 LLM 代理',
  '我的第一个 AI 代理'
);

// 添加到管理器
agentManager.addAgent(baseAgent);

// 运行代理
const result = await agentManager.runAgent('base_agent', '你好，我是用户');
console.log('代理回复:', result);

// 创建会话
const session = await sessionManager.createSession('我的会话', '测试会话');
console.log('会话创建成功:', session.id);
```

## 代理系统

### 创建不同类型的代理

```typescript
import { AgentFactory } from 'artemis/core/adk/agent_factory';

// 1. LLM 代理
const llmAgent = AgentFactory.createLlmAgent(
  'llm_agent',
  'LLM 代理',
  '通用 LLM 代理',
  {
    temperature: 0.7,
    maxTokens: 2048,
    model: 'gpt-4'
  }
);

// 2. 循环代理
const loopAgent = AgentFactory.createLoopAgent(
  'loop_agent',
  '循环代理',
  '重复执行任务',
  llmAgent,
  { temperature: 0.5 },
  5,
  (result) => result.includes('完成')
);

// 3. 并行代理
const parallelAgent = AgentFactory.createParallelAgent(
  'parallel_agent',
  '并行代理',
  '并行执行多个任务',
  [llmAgent, loopAgent]
);

// 4. 顺序代理
const sequentialAgent = AgentFactory.createSequentialAgent(
  'sequential_agent',
  '顺序代理',
  '按顺序执行任务',
  [llmAgent, loopAgent]
);

// 5. 路由代理
const routedAgent = AgentFactory.createRoutedAgent(
  'routed_agent',
  '路由代理',
  '根据条件路由到不同代理',
  [
    AgentFactory.createRoutingRule(
      '技术问题',
      '处理技术问题',
      (input) => input.toLowerCase().includes('代码') || input.toLowerCase().includes('bug'),
      llmAgent,
      1
    ),
    AgentFactory.createRoutingRule(
      '一般问题',
      '处理一般问题',
      (input) => true,
      loopAgent,
      2
    )
  ]
);
```

### 代理配置

```typescript
import { AgentManager } from 'artemis/core/adk/agent_manager';

const agentManager = new AgentManager();

// 设置默认配置
agentManager.setDefaultConfig({
  temperature: 0.8,
  maxTokens: 4096,
  topP: 0.9,
  topK: 50,
  systemPrompt: 'You are an expert AI assistant.',
  toolExecutionMode: 'auto',
  enableStreaming: true,
  enableMemory: true,
  memoryLimit: 100,
  timeout: 600000,
  retryCount: 5,
  retryDelay: 2000
});

// 获取代理信息
const agentInfo = agentManager.getAgentInfo('base_agent');
console.log('代理信息:', agentInfo);

// 获取统计信息
const stats = agentManager.getStatusStatistics();
console.log('状态统计:', stats);
```

## 工具系统

### 创建和管理工具

```typescript
import { toolManager, ToolDefBuilder, ToolKind, ToolPermissionCategory } from 'artemis';

// 创建工具定义
const webSearchTool = new ToolDefBuilder()
  .setName('web_search')
  .setDescription('在网页上搜索信息')
  .setKind(ToolKind.WEB)
  .setPermissionCategory(ToolPermissionCategory.SAFE)
  .addParameter('query', '搜索查询')
  .addParameter('numResults', '结果数量')
  .build();

// 添加工具
toolManager.addTool(webSearchTool);

// 执行工具
const result = await toolManager.executeTool('web_search', {
  query: '人工智能发展趋势',
  numResults: 5
});

// 搜索工具
const tools = toolManager.findTools('web');
console.log('找到的工具:', tools);

// 获取统计信息
const stats = toolManager.getStatistics();
console.log('工具统计:', stats);
```

## 技能系统

### 技能管理

```typescript
import { skillManager, SkillManager } from 'artemis/core/adk/skill_manager';

// 加载技能
const skills = await skillManager.loadAllSkills();
console.log('技能数量:', skills.length);

// 激活技能
const codeAnalysisSkill = await skillManager.loadSkill('code_analysis');
await skillManager.activateSkill(codeAnalysisSkill.id);

// 执行技能
const result = await skillManager.executeSkill(codeAnalysisSkill.id, 
  'function calculateTotal(items) { return items.reduce((sum, item) => sum + item.price, 0); }');

console.log('代码分析结果:', result);
```

## 会话管理

### 会话操作

```typescript
import { sessionManager, InMemorySessionStorage } from 'artemis/core/adk/session_manager';

// 使用内存存储
const storage = new InMemorySessionStorage();
const manager = new SessionManager(storage);

// 创建会话
const session = await manager.createSession('开发会话', '代码开发工作区');
console.log('会话创建成功:', session.id);

// 添加参与者
session.addParticipant('user123');
session.addParticipant('agent456');

// 发送消息
session.sendMessage({
  role: 'user',
  content: '请帮我优化这个函数',
  sender: 'user123',
  timestamp: new Date()
});

// 搜索会话
const searchResults = manager.searchSessions('开发');
console.log('找到的会话:', searchResults);
```

## 流式处理

### 流操作

```typescript
import { streamManager, StreamHelper } from 'artemis/core/adk/stream_manager';

// 创建流
const textStream = streamManager.createStream('text_stream', '文本流', 'text');

// 订阅流
const subscriptionId = streamManager.subscribe(textStream.id, (data) => {
  console.log('收到数据:', data.content);
});

// 发送数据
textStream.push({
  type: 'text',
  content: 'Hello, world!',
  metadata: { source: 'system' },
  timestamp: new Date()
});

// 创建临时流
const tempStream = StreamHelper.createTemporaryStream('临时流');
tempStream.push({
  type: 'text',
  content: '临时数据',
  timestamp: new Date()
});
```

## 安全机制

### 安全配置和验证

```typescript
import { SecurityManager, DEFAULT_SECURITY_CONFIG } from 'artemis/core/adk/security_manager';

// 初始化安全管理器
const securityManager = new SecurityManager(DEFAULT_SECURITY_CONFIG);

// 验证 API 密钥
const apiKey = 'test_key_123';
const isValid = securityManager.validateApiKey(apiKey);
console.log('API 密钥验证:', isValid);

// 验证权限
const user = {
  id: 'user123',
  email: 'user@example.com',
  role: 'user'
};

const hasAccess = securityManager.hasPermission(user, 'tool:execute');
console.log('用户权限:', hasAccess);

// 记录安全审计
securityManager.recordAudit('authentication', 'info', '用户登录', {
  userId: user.id,
  ip: '192.168.1.100',
  userAgent: 'Mozilla/5.0...'
});

// 查看审计记录
const audits = securityManager.getAudits();
console.log('审计记录:', audits);
```

## 高级功能

### 复合代理系统

```typescript
import { AgentFactory, getAgentManagerInstance } from 'artemis/core/adk';

const agentManager = getAgentManagerInstance();

// 创建复杂代理系统
const complexSystem = AgentFactory.createComplexAgentSystem(
  'complex_system',
  '复杂代理系统',
  '处理复杂任务的综合代理'
);

// 运行系统
const result = await complexSystem.run('帮我写一个分析用户行为数据的程序');
console.log('执行结果:', result);
```

### 性能监控

```typescript
import { performanceMonitor } from 'artemis';

// 开始监控
performanceMonitor.start();

// 运行任务
// ...

// 结束监控
performanceMonitor.stop();

// 获取性能数据
const stats = performanceMonitor.getPerformanceStats();
console.log('性能统计:', stats);

// 清理
performanceMonitor.reset();
```

## API 参考

### 代理类

```typescript
class AgentManager {
  addAgent(agent: BaseAgent): void
  createAgent(agentType: string, params: any): BaseAgent
  getAgent(id: string): BaseAgent | undefined
  runAgent(id: string, input: string, context?: any): Promise<any>
  stopAgent(id: string): Promise<void>
  getStatusStatistics(): { [key: string]: number }
}
```

### 工具类

```typescript
class ToolManager {
  addTool(tool: ToolDefinition): void
  getTool(toolId: string): ToolDefinition | undefined
  executeTool(toolId: string, params: any): Promise<any>
  findTools(query: string): ToolDefinition[]
  getStatistics(): ToolStatistics
}
```

### 技能类

```typescript
class SkillManager {
  loadSkill(skillId: string): Promise<Skill>
  loadAllSkills(): Promise<Skill[]>
  activateSkill(skillId: string): Promise<Skill>
  executeSkill(skillId: string, input: string, context?: any): Promise<SkillExecutionResult>
  findSkills(query: string): Skill[]
  getStatistics(): SkillStatistics
}
```

### 会话类

```typescript
class Session {
  id: string
  name: string
  description: string
  messages: SessionMessage[]
  participants: string[]
  
  sendMessage(message: any): void
  getMessageCount(): number
  searchMessages(query: string): SessionMessage[]
}
```

## 最佳实践

### 1. 错误处理

```typescript
try {
  const result = await agentManager.runAgent('agent123', '复杂任务');
  console.log('执行成功:', result);
} catch (error) {
  console.error('执行失败:', error);
  
  // 记录错误信息
  securityManager.recordAudit('system', 'error', '任务执行失败', {
    error: error.message,
    timestamp: new Date().toISOString()
  });
}
```

### 2. 资源管理

```typescript
import { AgentManager } from 'artemis/core/adk/agent_manager';

const agentManager = new AgentManager();

// 创建代理
const agent = AgentFactory.createLlmAgent('temp_agent', '临时代理', '临时任务');
agentManager.addAgent(agent);

try {
  // 执行任务
  const result = await agent.run('执行任务');
  console.log('任务完成:', result);
} catch (error) {
  console.error('任务失败:', error);
} finally {
  // 清理资源
  agentManager.removeAgent(agent.id);
}
```

### 3. 配置管理

```typescript
import { DEFAULT_AGENT_CONFIG } from 'artemis/core/adk/agent_manager';

const customConfig = {
  ...DEFAULT_AGENT_CONFIG,
  temperature: 0.3,
  maxTokens: 8192,
  model: 'gpt-4'
};

const agent = AgentFactory.createLlmAgent('config_agent', '配置化代理', '自定义配置', customConfig);
```

## 扩展开发

### 创建自定义代理

```typescript
import { BaseAgent } from 'artemis/core/adk/base_agent';

class MyCustomAgent extends BaseAgent {
  constructor() {
    super('custom_agent', '自定义代理', '我的扩展代理');
  }
  
  async run(input: string, context?: any): Promise<any> {
    // 自定义执行逻辑
    return `Custom response to: ${input}`;
  }
  
  getDescription(): string {
    return '这是一个自定义的代理实现';
  }
}

// 使用自定义代理
const customAgent = new MyCustomAgent();
agentManager.addAgent(customAgent);
```

### 实现自定义工具

```typescript
import { ToolDefinition, ToolKind, ToolPermissionCategory } from 'artemis/core/adk/toolDef';

const MyToolDefinition: ToolDefinition = {
  name: 'my_custom_tool',
  description: '我的自定义工具',
  kind: ToolKind.COMMAND,
  permissionCategory: ToolPermissionCategory.SAFE,
  tags: ['custom', 'utility'],
  parameters: {
    'param1': {
      type: 'string',
      description: '第一个参数'
    }
  }
};

// 实现工具执行器
toolManager.registerExecutor(ToolKind.COMMAND, {
  execute: async (tool: ToolDefinition, params: any) => {
    return `执行了 ${tool.name} 工具，参数: ${JSON.stringify(params)}`;
  }
});

// 使用工具
toolManager.addTool(MyToolDefinition);
```

## 常见问题

### Q: 如何查看系统状态？

```typescript
import { getSystemInfo } from 'artemis';

const systemInfo = getSystemInfo();
console.log('系统信息:', systemInfo);
```

### Q: 如何配置安全设置？

```typescript
import { DEFAULT_SECURITY_CONFIG } from 'artemis/core/adk/security_manager';

const customSecurityConfig = {
  ...DEFAULT_SECURITY_CONFIG,
  authentication: {
    type: 'token',
    required: true
  }
};

securityManager.updateConfig(customSecurityConfig);
```

### Q: 如何调试？

```typescript
import { performanceMonitor } from 'artemis';

performanceMonitor.start();
// 运行操作
const result = await agentManager.runAgent('agent123', '调试任务');
console.log('结果:', result);
console.log('性能数据:', performanceMonitor.getPerformanceStats());
```

## 资源

- [GitHub 仓库](https://github.com/your-repo/artemis)
- [API 文档](https://api.artemis.dev)
- [示例代码](https://github.com/your-repo/artemis/examples)
- [支持论坛](https://discuss.artemis.dev)

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件
