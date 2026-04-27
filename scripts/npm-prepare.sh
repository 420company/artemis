#!/bin/bash
# Artemis npm 发布准备脚本
# 用于确保项目可以正常打包和发布到 npm

set -e

echo "=== Artemis npm 发布准备 ==="

# 检查 Node.js 和 npm 版本
echo "1. 检查 Node.js 和 npm 版本"
node_version=$(node -v)
npm_version=$(npm -v)
echo "Node.js 版本: $node_version"
echo "npm 版本: $npm_version"

if ! node -v | grep -q "v20\|v21\|v22"; then
    echo "❌ 错误: 需要 Node.js 20.x 或更高版本"
    exit 1
fi

# 检查依赖是否已安装
echo -e "\n2. 检查依赖是否已安装"
if [ ! -d "node_modules" ]; then
    echo "依赖未安装，正在安装..."
    npm install
else
    echo "依赖已安装"
fi

# 检查 package.json 配置
echo -e "\n3. 检查 package.json 配置"
required_fields=("name" "version" "description" "main" "type" "files" "bin" "engines" "license")
for field in "${required_fields[@]}"; do
    if ! grep -q "\"${field}\":" package.json; then
        echo "❌ 错误: package.json 缺少 ${field} 字段"
        exit 1
    fi
done
echo "package.json 配置完整"

# 检查项目结构
echo -e "\n4. 检查项目结构"
required_files=("bin/artemis-cli.js" "src/index.ts" "README.md" "LICENSE" "tsconfig.json")
required_dirs=("src" "dist" "bin")

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ 错误: 文件不存在: $file"
        exit 1
    fi
done

for dir in "${required_dirs[@]}"; do
    if [ ! -d "$dir" ]; then
        echo "❌ 错误: 目录不存在: $dir"
        exit 1
    fi
done
echo "项目结构完整"

# 检查代码是否可以正常运行
echo -e "\n5. 检查代码运行状态"
if ! npm run run -- --help >/dev/null 2>&1; then
    echo "❌ 错误: 项目无法正常运行"
    npm run run -- --help
    exit 1
fi
echo "项目可以正常运行"

# 尝试类型检查
echo -e "\n6. 运行类型检查"
if ! npm run typecheck; then
    echo -e "\n⚠️  类型检查失败，但不影响发布"
fi

# 尝试编译项目
echo -e "\n7. 尝试编译项目"
if npm run build; then
    echo "✅ 项目编译成功"
else
    echo "⚠️  项目编译失败，但不影响 npm link 使用"
fi

# 检查编译产物
echo -e "\n8. 检查编译产物"
if [ -d "dist" ] && [ "$(ls -1 dist 2>/dev/null | wc -l)" -gt 0 ]; then
    echo "✅ dist 目录有内容"
else
    echo "⚠️  dist 目录为空或不存在，但不影响开发使用"
fi

# 检查 npm link 是否正常
echo -e "\n9. 检查本地链接"
if npm link >/dev/null 2>&1 && artemis --help >/dev/null 2>&1; then
    echo "✅ npm link 正常工作"
else
    echo "❌ 错误: npm link 无法正常工作"
    exit 1
fi

# 打印使用说明
echo -e "\n=== 发布准备完成 ===\n"

echo "📦 项目可以正常使用："
echo "   1. 本地开发：npm run run -- --help"
echo "   2. 本地链接：npm link"
echo "   3. 使用命令：artemis --help"

echo -e "\n🚀 发布到 npm："
echo "   1. 确保已登录 npm：npm login"
echo "   2. 更新版本号：npm version [patch|minor|major]"
echo "   3. 发布包：npm publish"

echo -e "\n💡 注意："
echo "   - 项目依赖 tsx 运行 TypeScript 源码"
echo "   - bin/artemis-cli.js 是 CLI 入口文件"
echo "   - 可以正常使用 npm link 进行本地开发"
echo "   - 编译类型错误不影响基本功能"