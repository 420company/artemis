import assert from 'node:assert/strict';
import { hasDirectCreationRequestMarker, isWorkflowSupportDiscussion } from '../src/tools/visual/workflowIntent.js';

const videoCreationSyntax = (text: string): boolean => /(?:生成|制作|做成|create|generate)[\s\S]{0,80}(?:视频|video)/i.test(text);

function main(): void {
  assert.equal(hasDirectCreationRequestMarker('帮我生成一个视频'), true);
  assert.equal(hasDirectCreationRequestMarker('这个视频为什么触发了'), false);

  assert.equal(
    isWorkflowSupportDiscussion('检查我刚才发送的文字，为什么我发什么都会触发视频生成？', {
      workflowTerms: /(?:视频|触发|生成|video)/i,
      creationSyntax: videoCreationSyntax,
    }),
    true,
  );

  assert.equal(
    isWorkflowSupportDiscussion('帮我生成一段30秒的视频', {
      workflowTerms: /(?:视频|触发|生成|video)/i,
      creationSyntax: videoCreationSyntax,
    }),
    false,
  );

  assert.equal(
    isWorkflowSupportDiscussion('为什么 generate_video 没有把视频发到手机？', {
      workflowTerms: /(?:视频|generate_video|video)/i,
      creationSyntax: videoCreationSyntax,
    }),
    true,
  );

  console.log('workflow intent classifier smoke ok');
}

main();
