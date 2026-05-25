import {Injectable, OnModuleInit, Logger} from '@nestjs/common';
import {DiscoveryService, MetadataScanner, Reflector} from '@nestjs/core';
import {SKILL_METADATA, SkillMetadata} from './skill.decorator';
import {PrismaService} from '../../../framework/prisma/prisma.service';

@Injectable()
export class SkillRegistry implements OnModuleInit {
  private readonly logger = new Logger(SkillRegistry.name);
  private skills = new Map<string, {metadata: SkillMetadata; handler: (args: any) => any; instance: any}>();
  private activeSkills: SkillMetadata[] = []; // Skills loaded from DB

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService
  ) {}

  async onModuleInit() {
    this.discoverSkills();
    await this.syncSkillsToDb();
    await this.loadActiveSkillsFromDb();
  }

  private discoverSkills() {
    const providers = this.discoveryService.getProviders();

    providers.forEach(wrapper => {
      const {instance} = wrapper;
      if (!instance || typeof instance !== 'object') {
        return;
      }

      const prototype = Object.getPrototypeOf(instance);
      this.metadataScanner.scanFromPrototype(instance, prototype, (methodName: string) => {
        const method = instance[methodName];
        const metadata = this.reflector.get<SkillMetadata>(SKILL_METADATA, method);

        if (metadata) {
          this.skills.set(metadata.name, {
            metadata,
            handler: method,
            instance,
          });
        }
      });
    });
  }

  private async syncSkillsToDb() {
    for (const [name, skillInfo] of this.skills.entries()) {
      try {
        await this.prisma['skill'].upsert({
          where: {name},
          update: {
            description: skillInfo.metadata.description,
            parameters: skillInfo.metadata.parameters,
          },
          create: {
            name,
            description: skillInfo.metadata.description,
            parameters: skillInfo.metadata.parameters,
            isActive: true,
          },
        });
      } catch (e) {
        this.logger.error(`Failed to sync skill ${name} to DB`, e);
      }
    }
  }

  public async loadActiveSkillsFromDb() {
    try {
      const dbSkills = await this.prisma['skill'].findMany({
        where: {isActive: true},
      });
      this.activeSkills = dbSkills.map((s: any) => ({
        name: s.name,
        description: s.description,
        parameters: typeof s.parameters === 'string' ? JSON.parse(s.parameters) : s.parameters,
      }));
      this.logger.log(`Loaded ${this.activeSkills.length} active skills from DB`);
    } catch (e) {
      this.logger.error('Failed to load active skills from DB, falling back to local registry', e);
      this.activeSkills = Array.from(this.skills.values()).map(s => s.metadata);
    }
  }

  getSkill(name: string) {
    return this.skills.get(name);
  }

  getAllSkills() {
    // Return active skills from DB
    return this.activeSkills;
  }

  async executeSkill(name: string, args: any) {
    const skill = this.skills.get(name);
    if (!skill) {
      throw new Error(`Skill ${name} handler not found in system`);
    }
    return await skill.handler.call(skill.instance, args);
  }
}
