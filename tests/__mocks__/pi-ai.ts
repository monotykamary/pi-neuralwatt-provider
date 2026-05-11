// Stub for @earendil-works/pi-ai peer dependency

export interface SimpleStreamOptions {
  apiKey?: string;
}

export interface AssistantMessageEventStream {
  end: (result?: any) => void;
}

export function streamOpenAICompletions(
  _model: any,
  _context: any,
  _options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return {
    end() {},
  };
}
