import {SetMetadata} from '@nestjs/common';

export const SKILL_METADATA = 'SKILL_METADATA';

export interface SkillMetadata {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export function Skill(metadata: SkillMetadata) {
  return SetMetadata(SKILL_METADATA, metadata);
}
