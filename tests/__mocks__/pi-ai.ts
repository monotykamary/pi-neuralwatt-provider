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

// Minimal runtime-compatible assistant-message event stream (same queue +
// push/end/result + async-iteration semantics as pi-ai's EventStream).
export class AssistantMessageEventStream {
  private queue: any[] = [];
  private waiting: Array<(r: { value: any; done: boolean }) => void> = [];
  private done = false;
  private finalResultPromise: Promise<any>;
  private resolveFinalResult!: (value: any) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: any): void {
    if (this.done) return;
    if (event?.type === "done" || event?.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: any): void {
    this.done = true;
    if (result !== undefined) this.resolveFinalResult(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  result(): Promise<any> {
    return this.finalResultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<any, void, unknown> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<{ value: any; done: boolean }>((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
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
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => stream.end());
  return stream;
}

export function streamOpenAIResponses(
  model: any,
  context: any,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  __streamCalls.push({ model, context, options });
  const stream = new AssistantMessageEventStream();
  queueMicrotask(() => stream.end());
  return stream;
}
