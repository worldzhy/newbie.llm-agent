import {Module} from '@nestjs/common';
import {ConfigModule} from '@nestjs/config';
import {DiscoveryModule} from '@nestjs/core';
import {LlmAgentService} from './llm-agent.service.js';
import {LlmAgentController} from './llm-agent.controller.js';
import {SkillRegistry} from './skills/skill.registry';
import {LlmSkills} from './skills/llm.skills';
import {PrismaModule} from '../../framework/prisma/prisma.module';
import {LLMProviderFactory} from './providers/provider.factory';

@Module({
  imports: [ConfigModule, DiscoveryModule, PrismaModule],
  controllers: [LlmAgentController],
  providers: [LlmAgentService, SkillRegistry, LLMProviderFactory, LlmSkills],
  exports: [LlmAgentService, SkillRegistry],
})
export class LlmAgentModule {}
