import {Injectable} from '@nestjs/common';
import {Skill} from './skill.decorator';
import {LLMProviderFactory} from '../providers/provider.factory';

@Injectable()
export class LlmSkills {
  constructor(private readonly providerFactory: LLMProviderFactory) {}

  @Skill({
    name: 'queryLLMProviders',
    description:
      'Query the list of available Large Language Models (LLMs) in the system and their availability status.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  })
  async queryLLMProviders() {
    const providers = await this.providerFactory.getAvailableProviders();
    const current = await this.providerFactory.getCurrentProviderId();

    const formattedList = providers
      .map(p => {
        const status = p.isAvailable ? 'Available' : 'Unavailable - Missing API Key';
        const isCurrent = p.id === current ? ' [Current Active]' : '';
        return `- ${p.name} (ID: ${p.id}): ${status}${isCurrent}`;
      })
      .join('\n');

    return `System LLM Providers:\n${formattedList}`;
  }

  @Skill({
    name: 'switchLLMProvider',
    description:
      'Attempt to switch the current active Large Language Model (LLM). Note: Users are NOT allowed to switch models directly from chat.',
    parameters: {
      type: 'object',
      properties: {
        providerId: {
          type: 'string',
          description: 'The ID of the LLM provider to switch to (e.g., "openai", "qwen")',
        },
      },
      required: ['providerId'],
    },
  })
  async switchLLMProvider(args: {providerId: string}) {
    // Intercept chat attempts to switch model
    return JSON.stringify({
      success: false,
      message: `Please change the model in the management console. Switching to ${args.providerId} via chat is currently not supported.`,
      isSwitchAction: true,
    });
  }
}
