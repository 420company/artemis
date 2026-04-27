import { pickLocale, type UiLocale } from '../cli/locale.js';
import { MessagesCompatibleProvider } from './messagesCompatible.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { ResponsesCompatibleProvider } from './responsesCompatible.js';
import type {
  ChatProvider,
  ProviderConfig,
  ProviderProtocol,
} from './types.js';

export function normalizeProviderProtocol(
  value: string | undefined,
): ProviderProtocol {
  if (value === 'anthropic' || value === 'messages') {
    return 'messages';
  }

  if (value === 'responses') {
    return 'responses';
  }

  return 'openai';
}

export function formatProviderProtocolLabel(
  protocol: ProviderProtocol,
  locale: UiLocale = 'en',
): string {
  if (protocol === 'responses') {
    return pickLocale(locale, {
      zh: 'Responses 接口',
      en: 'Responses API',
    });
  }

  if (protocol === 'messages') {
    return pickLocale(locale, {
      zh: 'Messages 协议接口',
      en: 'Messages-compatible',
    });
  }

  return pickLocale(locale, {
    zh: 'OpenAI 兼容接口',
    en: 'OpenAI-compatible',
  });
}

export function createProviderFromConfig(
  config: ProviderConfig,
): ChatProvider {
  if (config.protocol === 'responses') {
    return new ResponsesCompatibleProvider(config);
  }

  return config.protocol === 'messages'
    ? new MessagesCompatibleProvider(config)
    : new OpenAICompatibleProvider(config);
}
