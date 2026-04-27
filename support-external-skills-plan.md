# 支持 Claude Code 和 OpenClaw 技能计划

## 1. 目标与背景

我们的系统需要支持外部技能格式，特别是：
- **Claude Code 技能**：Anthropic 开发的技能格式
- **OpenClaw 技能**：OpenClaw开发的技能格式

当前系统技能格式与这些外部格式存在差异，需要设计和实现转换器或适配器。

## 2. 差异分析

### 当前系统技能格式
```javascript
// SKILL.json 格式示例
{
  "id": "kaleidoscope",
  "name": "Kaleidoscope UI",
  "version": "1.0.0",
  "description": "生成现代化 UI 组件",
  "inputs": [
    {
      "name": "prompt",
      "type": "string",
      "required": true
    }
  ],
  "entryPoint": "tool_chain",
  "toolChain": [
    {
      "tool": "generateCode",
      "inputs": {
        "prompt": "{{inputs.prompt}}"
      }
    }
  ]
}
```

### 外部技能格式推测
虽然无法直接访问外部文档，但从行业标准和常见模式推测：

**Claude Code 技能格式（推测）**：
```json
{
  "name": "Web Scraper",
  "description": "Extract data from websites",
  "parameters": [
    {
      "name": "url",
      "type": "string",
      "description": "URL to scrape"
    }
  ],
  "entry": "scrape.js",
  "dependencies": ["puppeteer"]
}
```

**OpenClaw 技能格式（推测）**：
```json
{
  "id": "image-generator",
  "title": "Image Generator",
  "description": "Generate images from text",
  "inputs": [
    {
      "name": "text",
      "type": "text",
      "required": true
    }
  ],
  "execution": "python generate.py {{text}}",
  "requirements": ["pillow"]
}
```

## 3. 架构设计

### 3.1 技能适配器架构
```
外部技能格式 → 技能适配器 → 内部统一格式
```

### 3.2 组件设计

#### 技能发现器 (SkillDiscoverer)
- 发现外部技能源
- 识别技能类型（Claude Code / OpenClaw）
- 加载原始技能定义

#### 技能转换器 (SkillConverter)
- 实现格式转换逻辑
- 处理不同技能格式的差异
- 验证转换后的技能完整性

#### 技能验证器 (SkillValidator)
- 验证转换后的技能格式
- 检查依赖项和执行条件
- 确保技能可执行

## 4. 实现计划

### 阶段一：架构准备 (1-2天)
- 创建技能适配器接口
- 实现通用转换器基类
- 添加技能格式识别逻辑

### 阶段二：Claude Code 支持 (3-4天)
- 实现 Claude Code 技能发现器
- 开发 Claude Code 到内部格式的转换器
- 编写转换规则和测试用例
- 实现依赖项解析和验证

### 阶段三：OpenClaw 支持 (3-4天)
- 实现 OpenClaw 技能发现器
- 开发 OpenClaw 到内部格式的转换器
- 编写转换规则和测试用例
- 实现依赖项解析和验证

### 阶段四：集成与测试 (2-3天)
- 集成适配器到现有技能系统
- 测试多种外部技能的转换和执行
- 优化转换效率和错误处理

## 5. 核心代码实现

### 技能适配器接口
```typescript
interface SkillAdapter {
  supportsFormat(format: string): boolean;
  discoverSkills(directory: string): Promise<ExternalSkill[]>;
  convert(skill: ExternalSkill): Promise<SkillDefinition>;
  validate(skill: ExternalSkill): Promise<ValidationResult>;
}
```

### 技能转换流程
```typescript
class ExternalSkillManager {
  async loadExternalSkill(directory: string): Promise<SkillDefinition> {
    const adapter = this.getAdapterForDirectory(directory);
    const externalSkill = await adapter.discoverSkills(directory);
    const validation = await adapter.validate(externalSkill);
    
    if (validation.isValid) {
      return await adapter.convert(externalSkill);
    } else {
      throw new Error('Invalid external skill: ' + validation.errors.join(', '));
    }
  }
  
  private getAdapterForDirectory(directory: string): SkillAdapter {
    // 识别技能格式并返回对应的适配器
  }
}
```

## 6. 依赖管理

### 外部技能依赖解析
```typescript
interface DependencyResolver {
  resolveDependencies(dependencies: string[]): Promise<ResolvedDependency[]>;
  install(dependency: ResolvedDependency): Promise<void>;
}

class NpmDependencyResolver implements DependencyResolver {
  async resolveDependencies(dependencies: string[]): Promise<ResolvedDependency[]> {
    // 使用 npm 解析依赖
  }
  
  async install(dependency: ResolvedDependency): Promise<void> {
    // 使用 npm install 安装依赖
  }
}
```

## 7. 风险评估

### 7.1 格式不透明性风险
- 外部技能格式文档不完整或过时
- 需要通过示例技能反向工程
- 可能需要多种版本的适配器

### 7.2 依赖兼容性风险
- 外部技能依赖可能与系统环境冲突
- 需要隔离依赖环境（如 Docker 容器）
- 可能需要虚拟环境管理

### 7.3 执行安全性风险
- 外部技能可能包含恶意代码
- 需要沙箱执行机制
- 权限控制和资源限制

## 8. 验证策略

### 8.1 技能转换测试
- 创建不同格式技能的测试用例
- 验证转换后技能的执行结果
- 检查转换过程中的错误处理

### 8.2 功能测试
- 测试外部技能的加载和发现
- 验证技能转换的正确性
- 测试技能执行流程

### 8.3 性能测试
- 评估转换速度和内存使用
- 测试大量技能的并发加载
- 评估技能执行的性能影响

## 9. 后续优化

### 动态技能更新
- 实现技能版本检测和更新机制
- 支持增量技能转换
- 技能依赖项自动更新

### 技能缓存策略
- 缓存转换后的技能定义
- 优化重复技能加载速度
- 实现技能缓存失效机制

### 用户体验优化
- 提供技能转换状态和进度反馈
- 显示技能转换错误和警告
- 提供技能兼容性检查工具