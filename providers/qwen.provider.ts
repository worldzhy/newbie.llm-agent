import {Injectable, Logger} from '@nestjs/common';
import {HttpService} from '@nestjs/axios';
import {lastValueFrom} from 'rxjs';
import {ILLMProvider, LLMCallOptions, LLMMessage, LLMResponse, ProviderConfig} from './llm-provider.interface';

@Injectable()
export class QwenProvider implements ILLMProvider {
  private readonly logger = new Logger(QwenProvider.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly httpService: HttpService
  ) {
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    this.model = config.model || 'qwen-plus';
  }

  async call(messages: LLMMessage[], options?: LLMCallOptions): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('Qwen API Key is not configured');
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
      this.logger.error('Qwen API call failed', detail);
      throw new Error('Failed to communicate with Qwen provider.');
    }
  }
}
