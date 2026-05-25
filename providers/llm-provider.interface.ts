export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface LLMCallOptions {
  jsonMode?: boolean;
  tools?: LLMTool[];
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: any[];
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  version?: string | null;
}

export interface ILLMProvider {
  /**
   * Send a request to the LLM
   */
  call(messages: LLMMessage[], options?: LLMCallOptions): Promise<LLMResponse>;
}
