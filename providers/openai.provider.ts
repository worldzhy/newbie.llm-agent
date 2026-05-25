import {Injectable, Logger} from '@nestjs/common';
import {HttpService} from '@nestjs/axios';
import {lastValueFrom} from 'rxjs';
import {ILLMProvider, LLMCallOptions, LLMMessage, LLMResponse, ProviderConfig} from './llm-provider.interface';

@Injectable()
export class OpenaiProvider implements ILLMProvider {
  private readonly logger = new Logger(OpenaiProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly httpService: HttpService
  ) {
    if (!config.apiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.model = config.model || 'gpt-4o';
  }

  async call(messages: LLMMessage[], options?: LLMCallOptions): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('OpenAI API Key is not configured');
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
    } catch (error) {
      const err = error as any;
      const detail = err?.response?.data ?? (error instanceof Error ? error.message : String(error));
      this.logger.error('OpenAI API call failed', detail);
      throw new Error('Failed to communicate with OpenAI provider.');
    }
  }
}
