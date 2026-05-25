import {Injectable, Logger, BadRequestException} from '@nestjs/common';
import {HttpService} from '@nestjs/axios';
import {ILLMProvider} from './llm-provider.interface';
import {QwenProvider} from './qwen.provider';
import {OpenaiProvider} from './openai.provider';
import {DeepseekProvider} from './deepseek.provider';
import {ClaudeProvider} from './claude.provider';
import {PrismaService} from '../../../framework/prisma/prisma.service';

export interface ProviderInfo {
  id: string;
  name: string;
  isAvailable: boolean;
  model?: string;
  providerType?: string;
}

@Injectable()
export class LLMProviderFactory {
  private readonly logger = new Logger(LLMProviderFactory.name);
  private providerInstances = new Map<string, ILLMProvider>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService
  ) {}

  async getAvailableProviders(): Promise<ProviderInfo[]> {
    const models = await this.prisma['llmModel'].findMany({
      orderBy: {createdAt: 'asc'},
    });

    return models.map((m: any) => ({
      id: m.id,
      name: m.name,
      isAvailable: !!m.apiKey,
      model: m.model,
      providerType: m.provider,
    }));
  }

  async switchProvider(modelId: string): Promise<void> {
    const target = await this.prisma['llmModel'].findUnique({where: {id: modelId}});

    if (!target) {
      throw new BadRequestException(`Model '${modelId}' not found.`);
    }

    if (!target.apiKey) {
      throw new BadRequestException(`Model '${target.name}' is currently unavailable (missing API key).`);
    }

    // Set all to inactive
    await this.prisma['llmModel'].updateMany({
      data: {isActive: false},
    });

    // Set the target to active
    await this.prisma['llmModel'].update({
      where: {id: modelId},
      data: {isActive: true},
    });

    // Invalidate cached instances if necessary
    this.providerInstances.clear();
    
    this.logger.log(`Switched active LLM model to: ${target.name} (${target.provider})`);
  }

  async getCurrentProviderId(): Promise<string | null> {
    const active = await this.prisma['llmModel'].findFirst({
      where: {isActive: true},
    });
    return active?.id || null;
  }

  async getProvider(): Promise<ILLMProvider> {
    const activeModel = await this.prisma['llmModel'].findFirst({
      where: {isActive: true},
    });

    if (!activeModel) {
      throw new Error('No active LLM model configured in the database.');
    }

    if (this.providerInstances.has(activeModel.id)) {
      return this.providerInstances.get(activeModel.id)!;
    }

    const provider = await this.createProviderInstance(activeModel);
    this.providerInstances.set(activeModel.id, provider);
    return provider;
  }

  async createProviderInstance(model: any): Promise<ILLMProvider> {
    let provider: ILLMProvider;
    const config = {
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      model: model.model,
      version: model.version,
    };

    switch (model.provider) {
      case 'openai':
        provider = new OpenaiProvider(config, this.httpService);
        break;
      case 'deepseek':
        provider = new DeepseekProvider(config, this.httpService);
        break;
      case 'claude':
        provider = new ClaudeProvider(config, this.httpService);
        break;
      case 'qwen':
      default:
        provider = new QwenProvider(config, this.httpService);
        break;
    }

    return provider;
  }
}
