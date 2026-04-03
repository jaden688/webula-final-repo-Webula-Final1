export type AiProvider = 'ollama' | 'openai' | 'gemini' | 'anthropic';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-latest';
export const MAX_OLLAMA_REVIEW_CHARS = 60_000;

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
  };
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OpenAIChatResponse {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

interface AnthropicResponse {
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  content?: Array<{ type?: string; text?: string }>;
}

export interface OllamaCodeReviewRequest {
  provider?: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  fileName: string;
  filePath?: string;
  code: string;
}

export interface OllamaCodeReviewResult {
  model: string;
  content: string;
  totalDurationMs?: number;
  promptEvalCount?: number;
  evalCount?: number;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  provider?: AiProvider;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  messages: OllamaChatMessage[];
  temperature?: number;
}

const SYSTEM_PROMPT = `
You are a strict senior code reviewer.
Focus on correctness, security, reliability, and maintainability.
Prioritize concrete bugs and behavioral regressions over style comments.
Return findings in plain markdown with:
1) Critical issues
2) High risk issues
3) Medium/low issues
4) Suggested patch ideas
If there are no material issues, explicitly say "No major issues found" and list any testing gaps.
`.trim();

const normalizeBaseUrl = (baseUrl?: string) => {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) return DEFAULT_OLLAMA_BASE_URL;
  return trimmed.replace(/\/+$/, '');
};

const normalizeOpenAiBaseUrl = (baseUrl?: string) => {
  const trimmed = (baseUrl || '').trim();
  if (!trimmed) return DEFAULT_OPENAI_BASE_URL;
  return trimmed.replace(/\/+$/, '');
};

const normalizeModel = (model?: string, provider: AiProvider = 'ollama') => {
  const trimmed = (model || '').trim();
  if (trimmed) return trimmed;
  if (provider === 'openai') return DEFAULT_OPENAI_MODEL;
  if (provider === 'gemini') return DEFAULT_GEMINI_MODEL;
  if (provider === 'anthropic') return DEFAULT_ANTHROPIC_MODEL;
  return DEFAULT_OLLAMA_MODEL;
};

const nsToMs = (value?: number) => {
  if (!value || Number.isNaN(value)) return undefined;
  return Math.round(value / 1_000_000);
};

const LOCAL_OLLAMA_BASE_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;
const FETCH_NETWORK_ERROR_RE = /Failed to fetch|NetworkError|CORS|ERR_FAILED/i;

const getCurrentOrigin = () => {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return '';
  }
  return window.location.origin;
};

const extractMessageContent = (content: string | Array<{ type?: string; text?: string }> | undefined) => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item?.type === 'text' || !item?.type ? item?.text || '' : ''))
    .join('\n')
    .trim();
};

export const buildOllamaCorsHint = (baseUrl?: string) => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!LOCAL_OLLAMA_BASE_URL_RE.test(normalizedBaseUrl)) {
    return '';
  }

  const origin = getCurrentOrigin();
  const originLabel = origin || 'your app origin';
  const originValue = origin || '<your-app-origin>';

  return `If this app is running from ${originLabel}, Ollama must allow that origin. On the machine running Ollama, set OLLAMA_ORIGINS=${originValue} and restart Ollama, or run Webula locally instead of the hosted site.`;
};

export const formatOllamaError = (error: unknown, baseUrl?: string, provider: AiProvider = 'ollama') => {
  const message = error instanceof Error ? error.message : 'Unable to reach AI provider.';
  if (provider !== 'ollama') return message;
  const hint = buildOllamaCorsHint(baseUrl);

  if (hint && FETCH_NETWORK_ERROR_RE.test(message)) {
    return `${message} ${hint}`;
  }

  return message;
};

const ensureApiKey = (provider: AiProvider, apiKey?: string) => {
  if (provider === 'ollama') return;
  if ((apiKey || '').trim()) return;
  throw new Error(`${provider.toUpperCase()} API key is required.`);
};

const toGeminiContents = (messages: OllamaChatMessage[]) => {
  const withoutSystem = messages.filter((message) => message.role !== 'system');
  return withoutSystem.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
};

export const chatWithOllama = async (
  request: OllamaChatRequest,
): Promise<OllamaCodeReviewResult> => {
  const provider = request.provider ?? 'ollama';
  const model = normalizeModel(request.model, provider);
  ensureApiKey(provider, request.apiKey);

  if (provider === 'openai') {
    const baseUrl = normalizeOpenAiBaseUrl(request.baseUrl);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${request.apiKey?.trim() || ''}`,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
        }),
      });
    } catch (error) {
      throw new Error(formatOllamaError(error, baseUrl, provider));
    }

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`OpenAI request failed (${response.status} ${response.statusText}). ${details.slice(0, 220)}`);
    }
    const payload = await response.json() as OpenAIChatResponse;
    const content = extractMessageContent(payload.choices?.[0]?.message?.content);
    if (!content) throw new Error('OpenAI returned an empty response.');
    return {
      model: payload.model || model,
      content,
      promptEvalCount: payload.usage?.prompt_tokens,
      evalCount: payload.usage?.completion_tokens,
    };
  }

  if (provider === 'gemini') {
    const apiKey = request.apiKey?.trim() || '';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const systemPrompt = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
      .trim();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
          contents: toGeminiContents(request.messages),
          generationConfig: {
            temperature: request.temperature ?? 0.2,
          },
        }),
      });
    } catch (error) {
      throw new Error(formatOllamaError(error, undefined, provider));
    }

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`Gemini request failed (${response.status} ${response.statusText}). ${details.slice(0, 220)}`);
    }
    const payload = await response.json() as GeminiResponse;
    const content = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim() || '';
    if (!content) throw new Error('Gemini returned an empty response.');
    return {
      model,
      content,
      promptEvalCount: payload.usageMetadata?.promptTokenCount,
      evalCount: payload.usageMetadata?.candidatesTokenCount,
    };
  }

  if (provider === 'anthropic') {
    const apiKey = request.apiKey?.trim() || '';
    const systemPrompt = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
      .trim();
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));

    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: request.temperature ?? 0.2,
          system: systemPrompt || undefined,
          messages,
        }),
      });
    } catch (error) {
      throw new Error(formatOllamaError(error, undefined, provider));
    }

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`Anthropic request failed (${response.status} ${response.statusText}). ${details.slice(0, 220)}`);
    }
    const payload = await response.json() as AnthropicResponse;
    const content = payload.content?.map((item) => item.text || '').join('\n').trim() || '';
    if (!content) throw new Error('Anthropic returned an empty response.');
    return {
      model: payload.model || model,
      content,
      promptEvalCount: payload.usage?.input_tokens,
      evalCount: payload.usage?.output_tokens,
    };
  }

  const baseUrl = normalizeBaseUrl(request.baseUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: request.messages,
        options: {
          temperature: request.temperature ?? 0.2,
        },
      }),
    });
  } catch (error) {
    throw new Error(formatOllamaError(error, baseUrl, provider));
  }

  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch {
      details = '';
    }
    const suffix = details ? ` ${details.slice(0, 200)}` : '';
    throw new Error(`Ollama request failed (${response.status} ${response.statusText}).${suffix}`);
  }

  const payload = await response.json() as OllamaChatResponse;
  const content = payload.message?.content?.trim();
  if (!content) {
    throw new Error('Ollama returned an empty review response.');
  }

  return {
    model: payload.model || model,
    content,
    totalDurationMs: nsToMs(payload.total_duration),
    promptEvalCount: payload.prompt_eval_count,
    evalCount: payload.eval_count,
  };
};

export const reviewCodeWithOllama = async (
  request: OllamaCodeReviewRequest,
): Promise<OllamaCodeReviewResult> => {
  const cleanedCode = request.code.slice(0, MAX_OLLAMA_REVIEW_CHARS);
  const pathLabel = request.filePath ? `Path: ${request.filePath}` : 'Path: (not available)';
  return chatWithOllama({
    provider: request.provider ?? 'ollama',
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    model: request.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `File: ${request.fileName}`,
          pathLabel,
          '',
          'Review the code below:',
          '```',
          cleanedCode,
          '```',
        ].join('\n'),
      },
    ],
  });
};

export const chatWithProvider = chatWithOllama;
export const reviewCodeWithProvider = reviewCodeWithOllama;
