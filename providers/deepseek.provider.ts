import {Injectable, Logger} from '@nestjs/common';
import {HttpService} from '@nestjs/axios';
import {lastValueFrom} from 'rxjs';
import {ILLMProvider, LLMCallOptions, LLMMessage, LLMResponse, ProviderConfig} from './llm-provider.interface';

@Injectable()
export class DeepseekProvider implements ILLMProvider {
  private readonly logger = new Logger(DeepseekProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly httpService: HttpService
  ) {
    if (!config.apiKey) {
      this.logger.warn('DEEPSEEK_API_KEY is not configured');
    }
    this.apiKey = config.apiKey || '';
    // DeepSeek API is compatible with OpenAI format
    this.baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';
    this.model = config.model || 'deepseek-chat';
  }

  async call(messages: LLMMessage[], options?: LLMCallOptions): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('DeepSeek API Key is not configured');
    }

    const payload: any = {
      model: this.model,
      messages,
      temperature: 0.7,
    };

    if (options?.jsonMode) {
      payload.response_format = {type: 'json_object'};
    }

    if (options?.tools && options.tools.length > 0) {
      payload.tools = options.tools;
      payload.tool_choice = 'auto';
    }

    try {
      const response = await lastValueFrom(
        this.httpService.post(`${this.baseUrl}/chat/completions`, payload, {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        })
      );

      const message = response.data.choices[0].message;
      return {
        content: message.content,
        tool_calls: message.tool_calls,
      };
    } catch (error: any) {
      this.logger.error('DeepSeek API call failed', error.response?.data || error.message);
      throw new Error(`Failed to communicate with DeepSeek provider: ${error.message}`);
    }
  }
}
