import {Controller, Get, Post, Patch, Delete, Param, Body, HttpException, HttpStatus} from '@nestjs/common';
import {ApiTags, ApiOperation, ApiResponse, ApiBody, ApiProperty, ApiPropertyOptional} from '@nestjs/swagger';
import {IsString, IsNotEmpty, IsOptional, IsIn} from 'class-validator';
import {LlmAgentService} from './llm-agent.service';

export class SwitchProviderDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  providerId: string;
}

export class CreateLlmModelDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({enum: ['qwen', 'openai', 'deepseek', 'claude']})
  @IsString()
  @IsNotEmpty()
  @IsIn(['qwen', 'openai', 'deepseek', 'claude'])
  provider: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  baseUrl: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  version?: string;
}

export class UpdateLlmModelDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({enum: ['qwen', 'openai', 'deepseek', 'claude']})
  @IsString()
  @IsOptional()
  @IsIn(['qwen', 'openai', 'deepseek', 'claude'])
  provider?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  model?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  baseUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  apiKey?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  version?: string;
}

@ApiTags('LLM Agent')
@Controller('llm')
export class LlmAgentController {
  constructor(private readonly llmAgentService: LlmAgentService) {}

  @Get('providers')
  @ApiOperation({summary: 'Get list of available LLM providers'})
  @ApiResponse({status: 200, description: 'List of providers returned successfully.'})
  async getProviders() {
    return {
      currentProvider: await this.llmAgentService.getCurrentProvider(),
      providers: await this.llmAgentService.getAvailableProviders(),
    };
  }

  @Post('provider/switch')
  @ApiOperation({summary: 'Switch the active LLM provider dynamically'})
  @ApiBody({type: SwitchProviderDto})
  @ApiResponse({status: 200, description: 'Provider switched successfully.'})
  @ApiResponse({status: 400, description: 'Provider not supported or unavailable.'})
  async switchProvider(@Body() body: SwitchProviderDto) {
    if (!body || !body.providerId) {
      throw new HttpException('providerId is required', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.llmAgentService.switchProvider(body.providerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpException(message, HttpStatus.BAD_REQUEST);
    }
  }

  @Get('models')
  @ApiOperation({summary: 'Get all LLM models'})
  async getModels() {
    return await this.llmAgentService.getModels();
  }

  @Post('models')
  @ApiOperation({summary: 'Create a new LLM model'})
  async createModel(@Body() dto: CreateLlmModelDto) {
    return await this.llmAgentService.createModel(dto);
  }

  @Patch('models/:id')
  @ApiOperation({summary: 'Update an LLM model'})
  async updateModel(@Param('id') id: string, @Body() dto: UpdateLlmModelDto) {
    return await this.llmAgentService.updateModel(id, dto);
  }

  @Delete('models/:id')
  @ApiOperation({summary: 'Delete an LLM model'})
  async deleteModel(@Param('id') id: string) {
    return await this.llmAgentService.deleteModel(id);
  }

  @Post('models/:id/test')
  @ApiOperation({summary: 'Test an LLM model connection'})
  async testModel(@Param('id') id: string) {
    return await this.llmAgentService.testModel(id);
  }
}
