import {Injectable, Logger} from '@nestjs/common';
import {HttpService} from '@nestjs/axios';
import {lastValueFrom} from 'rxjs';
import {ILLMProvider, LLMCallOptions, LLMMessage, LLMResponse, ProviderConfig} from './llm-provider.interface';

@Injectable()
export class ClaudeProvider implements ILLMProvider {
  private readonly logger = new Logger(ClaudeProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly anthropicVersion: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly httpService: HttpService
  ) {
    if (!config.apiKey) {
      this.logger.warn('CLAUDE_API_KEY is not configured');
    }
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
    this.model = config.model || 'claude-3-5-sonnet-20241022';
    this.anthropicVersion = config.version || '2023-06-01';
  }

  // Convert generic LLMMessage to Claude's message format
  private formatMessages(messages: LLMMessage[]): {system?: string; messages: any[]} {
    let system = '';
    const formattedMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n' : '') + msg.content;
      } else if (msg.role === 'tool') {
        // Claude expects tool results as 'user' role with a specific content structure
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Claude assistant tool calls
        const toolUseContents = msg.tool_calls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
        }));

        formattedMessages.push({
          role: 'assistant',
          content: msg.content ? [{type: 'text', text: msg.content}, ...toolUseContents] : toolUseContents,
        });
      } else {
        formattedMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return {system: system || undefined, messages: formattedMessages};
  }

  // Convert generic tools to Claude's tool format
  private formatTools(tools?: any[]): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  async call(messages: LLMMessage[], options?: LLMCallOptions): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Claude API Key is not configured');
    }

    const {system, messages: claudeMessages} = this.formatMessages(messages);

    const payload: any = {
      model: this.model,
      max_tokens: 4096,
      messages: claudeMessages,
      temperature: 0.7,
    };

    if (system) {
      payload.system = system;
    }

    const claudeTools = this.formatTools(options?.tools);
    if (claudeTools) {
      payload.tools = claudeTools;
    }

    try {
      const response = await lastValueFrom(
        this.httpService.post(`${this.baseUrl}/messages`, payload, {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': this.anthropicVersion,
            'Content-Type': 'application/json',
          },
        })
      );

      const data = response.data;

      let textContent = '';
      const toolCalls: any[] = [];

      // Parse Claude's content array
      for (const block of data.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      return {
        content: textContent || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error: any) {
      this.logger.error('Claude API call failed', error.response?.data || error.message);
      throw new Error(`Failed to communicate with Claude provider: ${error.message}`);
    }
  }
}
