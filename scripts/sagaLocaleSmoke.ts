import { resolveSagaWorkflowLocaleForTest } from '../src/tools/visual/sagaWorkflow.js';

const mixedChineseRequest = `目标：基于给定的三视图完成一个 30 秒夜晚海边长视频测试。
关键细节：使用三视图文件路径，场景要求夜晚海边，灯红酒绿纸醉金迷。
[Visual generation policy]
The user explicitly approved local visual generation. Photographic product editorial lifestyle assets MUST be produced via generate_image or generate_video when appropriate.
[Saga Narrative Constitution]
RULES in priority order protagonist mode character long-video pipeline generate_long_video reference_image continuity engine transitions audio normalization.`;

const englishRequest = `Create a 30 second long-form seaside nightlife video using the provided character turnaround reference. Please use the long video pipeline.`;

const chineseLocale = resolveSagaWorkflowLocaleForTest(mixedChineseRequest);
if (chineseLocale !== 'zh-CN') {
  throw new Error(`Expected mixed Chinese request to use zh-CN, got ${chineseLocale}`);
}

const englishLocale = resolveSagaWorkflowLocaleForTest(englishRequest);
if (englishLocale !== 'en') {
  throw new Error(`Expected English request to use en, got ${englishLocale}`);
}

const explicitChineseLocale = resolveSagaWorkflowLocaleForTest(englishRequest, 'zh-CN');
if (explicitChineseLocale !== 'zh-CN') {
  throw new Error(`Expected explicit zh-CN locale to win, got ${explicitChineseLocale}`);
}

const explicitEnglishLocale = resolveSagaWorkflowLocaleForTest(mixedChineseRequest, 'en');
if (explicitEnglishLocale !== 'en') {
  throw new Error(`Expected explicit en locale to win, got ${explicitEnglishLocale}`);
}

console.log('saga locale smoke ok');
