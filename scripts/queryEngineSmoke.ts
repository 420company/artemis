#!/usr/bin/env node

/**
 * scripts/queryEngineSmoke.ts — 查询引擎测试脚本
 *
 * 验证查询引擎的基本功能
 */

import { QueryEngine } from '../src/core/queryEngine.ts';

async function runQueryEngineTests() {
  console.log('🧪 运行查询引擎测试...');

  try {
    // 创建查询引擎实例
    const engine = new QueryEngine({ cwd: process.cwd() });

    // 测试1: 执行查询
    console.log('\n1. 测试执行查询');
    const queryResult = await engine.executeQuery('你好，我是用户');
    console.log('✅ 查询执行成功');
    console.log('   - 响应:', queryResult.response);
    console.log('   - 会话ID:', queryResult.sessionId);
    console.log('   - 执行时间:', queryResult.durationMs, 'ms');

    console.log('\n🎉 所有查询引擎测试通过！');
  } catch (error) {
    console.error('\n❌ 查询引擎测试失败:', error);
    process.exit(1);
  }
}

runQueryEngineTests();