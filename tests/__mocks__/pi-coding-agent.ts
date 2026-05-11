// Stub for @earendil-works/pi-coding-agent peer dependency

export interface ExtensionAPI {
  registerProvider(_name: string, _provider: any): void;
  on(_event: string, _handler: any): void;
  appendEntry(_type: string, _data: any): void;
  events: { emit(_event: string, _data: any): void };
}

export interface ModelRegistry {
  getApiKeyForProvider(_provider: string): Promise<string | null>;
}

export interface ExtensionContext {
  hasUI: boolean;
  ui: any;
  sessionManager: any;
  modelRegistry: ModelRegistry;
}
