// Stub for @earendil-works/pi-ai peer dependency.
//
// Runtime-shape-compatible exports for tests. Also records streamOpenAICompletions
// calls and lets tests override clampThinkingLevel via __setClamp, so tests can
// assert how streamNeuralwatt forwards the user's thinking selection
// (reasoning → reasoningEffort) without depending on real pi-ai internals.

export interface SimpleStreamOptions {
  apiKey?: string;
  reasoning?: string;
  onPayload?: (params: any, model: any) => any | Promise<any>;
}

export interface AssistantMessageEventStream {
  end: (result?: any) => void;
}

export const __streamCalls: Array<{ model: any; context: any; options: any }> = [];

export function __resetStreamCalls(): void {
  __streamCalls.length = 0;
}

let __clampImpl: (model: any, level: any) => any = (_model, level) => level;

export function __setClamp(fn: (model: any, level: any) => any): void {
  __clampImpl = fn;
}

export function clampThinkingLevel(model: any, level: any): any {
  return __clampImpl(model, level);
}

export function streamOpenAICompletions(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  __streamCalls.push({ model, context, options });
  return {
    end() {},
  };
}
