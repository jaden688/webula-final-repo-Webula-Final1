export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b';
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

export interface OllamaCodeReviewRequest {
  baseUrl?: string;
  model?: string;
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
  baseUrl?: string;
  model?: string;
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

const normalizeModel = (model?: string) => {
  const trimmed = (model || '').trim();
  if (!trimmed) return DEFAULT_OLLAMA_MODEL;
  return trimmed;
};

const nsToMs = (value?: number) => {
  if (!value || Number.isNaN(value)) return undefined;
  return Math.round(value / 1_000_000);
};

export const chatWithOllama = async (
  request: OllamaChatRequest,
): Promise<OllamaCodeReviewResult> => {
  const baseUrl = normalizeBaseUrl(request.baseUrl);
  const model = normalizeModel(request.model);

  const response = await fetch(`${baseUrl}/api/chat`, {
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
    baseUrl: request.baseUrl,
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
