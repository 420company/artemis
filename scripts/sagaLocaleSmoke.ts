import { DEFAULT_UI_LOCALE } from '../src/cli/locale.js';
import { resolveSagaWorkflowLocaleForTest } from '../src/tools/visual/sagaWorkflow.js';

const explicitChineseLocale = resolveSagaWorkflowLocaleForTest('zh-CN');
if (explicitChineseLocale !== 'zh-CN') {
  throw new Error(`Expected explicit zh-CN locale to win, got ${explicitChineseLocale}`);
}

const explicitEnglishLocale = resolveSagaWorkflowLocaleForTest('en');
if (explicitEnglishLocale !== 'en') {
  throw new Error(`Expected explicit en locale to win, got ${explicitEnglishLocale}`);
}

const fallbackLocale = resolveSagaWorkflowLocaleForTest();
if (fallbackLocale !== DEFAULT_UI_LOCALE) {
  throw new Error(`Expected missing locale to fall back to ${DEFAULT_UI_LOCALE}, got ${fallbackLocale}`);
}

console.log('saga locale smoke ok');
