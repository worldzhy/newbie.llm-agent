import {Injectable, Logger, BadRequestException} from '@nestjs/common';
import {SkillRegistry} from './skills/skill.registry';
import {LLMProviderFactory} from './providers/provider.factory';
import {LLMMessage} from './providers/llm-provider.interface';
import {PrismaService} from '../../framework/prisma/prisma.service';

export enum UserIntent {
  CHAT = 'CHAT', // Casual chat
  BREAKDOWN_REQUEST = 'BREAKDOWN_REQUEST', // User wants to break down a requirement
  TASK_CONFIRMATION = 'TASK_CONFIRMATION', // User confirms the current tasks
  TASK_MODIFICATION = 'TASK_MODIFICATION', // User wants to modify/update tasks
  TASK_QUERY = 'TASK_QUERY', // User asks about current tasks
  END_CONVERSATION = 'END_CONVERSATION', // User wants to end/stop the conversation
  INIT_GROUP = 'INIT_GROUP', // User wants to initialize the current chat group (TaskGroup & members)
  SKILL_INVOCATION = 'SKILL_INVOCATION', // User wants to use a specific system skill
}

export interface IntentAnalysisResult {
  intent: UserIntent;
  reasoning: string;
}

export enum LLMTaskStatus {
  PENDING = 'PENDING',
  DEVELOPING = 'DEVELOPING',
  TESTING = 'TESTING',
  DEPLOYED = 'DEPLOYED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: LLMTaskStatus | string;
}

@Injectable()
export class LlmAgentService {
  private readonly logger = new Logger(LlmAgentService.name);

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly providerFactory: LLMProviderFactory,
    private readonly prisma: PrismaService
  ) {
    this.logger.log('LlmAgentService initialized');
  }

  private async callLLM(messages: LLMMessage[], jsonMode: boolean = false, tools: any[] = []): Promise<any> {
    try {
      // Always get the provider right before calling, in case it was switched dynamically
      const provider = await this.providerFactory.getProvider();
      return await provider.call(messages, {jsonMode, tools});
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      this.logger.error(`Error calling LLM: ${errorMessage}`, error?.stack);
      throw error;
    }
  }

  async getAvailableProviders() {
    return await this.providerFactory.getAvailableProviders();
  }

  async getCurrentProvider() {
    return await this.providerFactory.getCurrentProviderId();
  }

  async switchProvider(providerId: string) {
    await this.providerFactory.switchProvider(providerId);
    return {success: true, currentProvider: providerId};
  }

  // --- LLM Models Management ---

  async getModels() {
    const models = await this.prisma['llmModel'].findMany({
      orderBy: {createdAt: 'asc'},
    });
    // Mask API keys for security before returning to frontend
    return models.map(m => ({
      ...m,
      apiKey: m.apiKey ? '********' + m.apiKey.slice(-4) : '',
    }));
  }

  async createModel(dto: any) {
    // If it's the first model, make it active
    const count = await this.prisma['llmModel'].count();
    const isActive = count === 0;

    const dataToCreate = {...dto, isActive};
    if (dataToCreate.version === '') {
      dataToCreate.version = null;
    }

    return await this.prisma['llmModel'].create({
      data: dataToCreate,
    });
  }

  async updateModel(id: string, dto: any) {
    const dataToUpdate = {...dto};

    // If the apiKey comes in as masked, don't update it
    if (dataToUpdate.apiKey && dataToUpdate.apiKey.startsWith('********')) {
      delete dataToUpdate.apiKey;
    }

    if (dataToUpdate.version === '') {
      dataToUpdate.version = null;
    }

    return await this.prisma['llmModel'].update({
      where: {id},
      data: dataToUpdate,
    });
  }

  async deleteModel(id: string) {
    const model = await this.prisma['llmModel'].findUnique({where: {id}});
    if (model?.isActive) {
      throw new BadRequestException('Cannot delete the currently active model. Switch to another model first.');
    }
    return await this.prisma['llmModel'].delete({
      where: {id},
    });
  }

  async testModel(id: string) {
    const model = await this.prisma['llmModel'].findUnique({where: {id}});
    if (!model) {
      throw new BadRequestException('Model not found');
    }

    try {
      // Test without modifying the active state in DB
      const provider = await this.providerFactory.createProviderInstance(model);
      const response = await provider.call([{role: 'user', content: 'ping'}]);

      if (response && response.content) {
        return {success: true, message: 'Connection successful'};
      } else {
        return {success: false, message: 'No content received from model'};
      }
    } catch (error: any) {
      throw new BadRequestException(`Connection failed: ${error.message}`);
    }
  }

  async analyzeIntent(userMessage: string, context: any = {}): Promise<IntentAnalysisResult> {
    const activeSkills = this.skillRegistry.getAllSkills();
    const skillsPromptInfo = activeSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');

    const systemPrompt = `
You are an intelligent assistant for a task management bot.
Your goal is to analyze the user's latest message and determine their intent based on the conversation context.

Context:
- Current Session Status: ${context.status || 'IDLE'} (e.g., IDLE, WAITING_CONFIRMATION)
- Has Pending Tasks: ${context.hasPendingTasks ? 'Yes' : 'No'}

Available Intents:
1. BREAKDOWN_REQUEST: The user EXPLICITLY asks to create tasks, break down a requirement, or provides a clear, actionable requirement that needs project management. 
   - Examples: "Please break down this feature", "Create a task for login", "I need to implement a new API, help me plan it.", "拆解任务到 solidcore 项目中", "拆解需求".
   - NOT Examples: "How are you?", "What is this bot?", "The weather is nice", "I'm just testing", "我的周报告如下：1. xxx 2. xxx" (this is a report, not a breakdown request).
2. TASK_CONFIRMATION: The user agrees to the proposed tasks or explicitly wants to save them. (Only valid if Status is WAITING_CONFIRMATION)
   - Examples: "OK", "Confirm", "Looks good", "保存", "保存任务", "确认", "没问题".
3. TASK_MODIFICATION: The user wants to change, add, or delete specific tasks from the proposed list. (Only valid if Status is WAITING_CONFIRMATION or IDLE with existing tasks)
4. TASK_QUERY: The user asks about current tasks in the system, or queries existing tasks GENERALLY without specifying a person or project (e.g., "what are my tasks" -> THIS IS WRONG, "my tasks" should be SKILL_INVOCATION. "查看自己的报告" -> THIS IS WRONG, reports are SKILL_INVOCATION. Correct examples: "list pending tasks", "show me completed tasks", "下一页", "上一页", "当前有哪些任务").
5. END_CONVERSATION: The user explicitly wants to end the conversation, clear the session, cancel the current action, or stop the bot.
   - Examples: "Stop", "End chat", "Bye", "Cancel", "Clear session", "Reset", "取消", "退出", "停止", "不要了".
6. INIT_GROUP: The user wants to initialize the current group and sync members into DB (TaskGroup & TaskUser). This is a one-time or idempotent action.
   - Examples: "初始化", "初始化群", "初始化项目组", "init", "initialize".
7. CHAT: Casual conversation, questions, greeting, or unclear intent. DEFAULT to this if unsure.
8. SKILL_INVOCATION: The user wants to use a specific system skill (e.g., query LLM providers, update task status, delete tasks, get task details, update assignee, query tasks by assignee, query/create projects, update task project, update task due date, submit/query weekly/monthly reports). If the user asks "what models are available", "delete task 1", "查看任务信息", "把任务 1 分配给小明", "当前@小明 负责的任务", "我的任务有哪些", "我当前的任务", "有哪些项目", "有哪些项目组", "把任务放到xxx项目里", "这是我的周总结", "我的周报告如下", "提交本周报告", "提交我的周报告", "提交周报", "这是我的周报", "本周工作总结", "查看小明的周总结", "查看我的本周总结", "查看我的本周报告", "我要查看自己本周的报告", "查看自己的报告", "把我本周的报告发出来", "我的周报告", "查看xxx项目上个月的月报", "生成xxx项目的月报", "nightwatch项目中的任务", choose this intent. Do NOT use this for querying tasks, use TASK_QUERY instead, EXCEPT when the user explicitly asks to query tasks BY ASSIGNEE (e.g., "我的任务有哪些", "小明的任务") or BY PROJECT (e.g., "某某项目里的任务", "nightwatch项目中的任务"), in which case you MUST choose SKILL_INVOCATION so you can call queryTasks with assigneeName or projectName.

Available Skills for SKILL_INVOCATION:
${skillsPromptInfo}

IMPORTANT RULES:
- Users are NOT allowed to switch LLM models. If they ask to switch, still classify as SKILL_INVOCATION so the tool can reject them gracefully.
- If the user asks about the bot's capabilities, or available models, strongly consider SKILL_INVOCATION.
- If the user asks to "break down" or "拆解任务", EVEN IF they mention a project name (e.g., "拆解任务到xxx项目"), you MUST classify it as BREAKDOWN_REQUEST, NOT SKILL_INVOCATION or queryProjects.
- If the user is just saying "Hello" or asking general questions, it is CHAT.
- If the user's input is ambiguous, classify it as CHAT.
- Only classify as BREAKDOWN_REQUEST if the user clearly wants to start a task planning process.
- If the user says "Stop" or "Bye", classify as END_CONVERSATION.

Output JSON format:
{
  "intent": "IntentEnum",
  "reasoning": "Short explanation"
}
`;

    const response = await this.callLLM(
      [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userMessage},
      ],
      true
    );

    try {
      const parsed = JSON.parse(response.content || '{}');
      return parsed;
    } catch (e) {
      this.logger.error('Failed to parse intent JSON', e);
      return {intent: UserIntent.CHAT, reasoning: 'Failed to parse intent'};
    }
  }

  async breakdownTask(requirement: string): Promise<TaskItem[]> {
    const systemPrompt = `
You are a project manager. Break down the user's requirement into actionable tasks.

IMPORTANT:
- If the input contains "[Referenced Message]", treat that as the PRIMARY requirement to break down.
- If the input DOES NOT contain "[Referenced Message]" AND the "User Input" ONLY contains a short command like "break this down", "拆解任务", "拆解任务到xxx项目里", WITHOUT ANY ACTUAL REQUIREMENT TEXT to break down, you MUST return an empty "tasks" array. Do NOT invent tasks if there is no requirement.
- The "User Input" might just be a command like "break this down" or "plan this". Ignore it if it doesn't contain requirements.
- If the user explicitly asks to put the tasks into a specific project (e.g., "拆解到xxx项目里"), make sure to note that context. However, right now the output schema only supports title and description. You can prefix the title with the project name if needed, or we will handle it in a future update.

Return a JSON object with a "tasks" array.
Each task should have:
- id: string (unique short id, e.g., "1", "2")
- title: string
- description: string (concise)
- status: "PENDING"

Output JSON format:
{
  "tasks": [
    { "id": "1", "title": "...", "description": "...", "status": "PENDING" }
  ]
}
`;
    const response = await this.callLLM(
      [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: requirement},
      ],
      true
    );

    try {
      const parsed = JSON.parse(response.content || '{}');
      return (parsed.tasks || []).map((t: any) => ({
        ...t,
        status: LLMTaskStatus[t.status as keyof typeof LLMTaskStatus] || t.status || LLMTaskStatus.PENDING,
      }));
    } catch (e) {
      return [];
    }
  }

  async modifyTasks(currentTasks: TaskItem[], instruction: string): Promise<TaskItem[]> {
    const systemPrompt = `
You are a project manager.
The user wants to modify the current list of tasks.
Current Tasks:
${JSON.stringify(currentTasks, null, 2)}

User Instruction: "${instruction}"

Return the updated list of tasks in JSON format.
{
  "tasks": [...]
}
`;
    const response = await this.callLLM(
      [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: instruction},
      ],
      true
    );

    try {
      const parsed = JSON.parse(response.content || '{}');
      return (parsed.tasks || currentTasks).map((t: any) => ({
        ...t,
        status: LLMTaskStatus[t.status as keyof typeof LLMTaskStatus] || t.status || LLMTaskStatus.PENDING,
      }));
    } catch (e) {
      return currentTasks;
    }
  }

  async extractTaskQueryStatus(userMessage: string): Promise<string | undefined> {
    const systemPrompt = `
Analyze the user's message and extract the task status they are querying for.
Available Statuses: PENDING, DEVELOPING, TESTING, DEPLOYED, COMPLETED, CANCELLED.

Rules:
- If the user is asking for "completed" or "finished" or "done" or "已完成" or "完成", return "COMPLETED".
- If the user is asking for "pending" or "to do" or "todo" or "未完成" or "待处理", return "PENDING".
- If the user is asking for "developing" or "doing" or "开发中" or "正在做", return "DEVELOPING".
- If the user is asking for "testing" or "测试中", return "TESTING".
- If the user is asking for ALL tasks or doesn't specify a status, return "ALL".
- ONLY return the status string or "ALL". DO NOT include any other text.

Example:
User: "还有哪些完成的任务" -> COMPLETED
User: "我的任务列表" -> ALL
User: "未完成的任务有哪些" -> PENDING
`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userMessage},
        ],
        false // Not JSON mode, just a string
      );

      const status = response.content?.trim().toUpperCase();
      if (status === 'ALL') return undefined;
      return status;
    } catch (e) {
      return undefined;
    }
  }

  async extractProjectName(userMessage: string): Promise<string | undefined> {
    const systemPrompt = `
Analyze the user's message and extract the name of the project they want to assign tasks to during a breakdown request.

Rules:
- If the user says "拆解到xxx项目中", "把这些放到xxx项目", "新建任务到xxx里" etc., extract "xxx".
- Return ONLY the exact project name.
- Do NOT include words like "项目", "里", "中", "的" unless they are part of the actual name.
- If no project is mentioned, return the exact string "NONE".

Example:
User: "帮我把这个需求拆解到电商重构项目里" -> 电商重构
User: "拆解任务" -> NONE
User: "把这些任务归档到 V2.0 项目" -> V2.0
`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userMessage},
        ],
        false
      );

      const name = response.content?.trim();
      if (name === 'NONE' || !name) return undefined;
      return name;
    } catch (e) {
      return undefined;
    }
  }

  async shouldIncludeCompletedTasks(userMessage: string): Promise<boolean> {
    const systemPrompt = `
You are a semantic analyzer for a task management bot.
Determine if the user's query implies they want to see "completed" (已完成) or "all" (所有/全部) tasks, rather than just pending ones.

Return a JSON object:
{
  "includeCompleted": boolean
}

Examples returning true:
- "列出所有任务包含已完成的"
- "查看完成的任务"
- "所有任务"
- "包含已经做完的"

Examples returning false:
- "当前有哪些任务"
- "我的任务"
- "开发中的任务"
- "列出任务"
`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userMessage},
        ],
        true // JSON mode
      );

      const parsed = JSON.parse(response.content || '{}');
      return !!parsed.includeCompleted;
    } catch (e) {
      this.logger.error('Failed to parse shouldIncludeCompletedTasks response', e);
      return false; // Default to false
    }
  }

  async analyzePaginationIntent(userMessage: string): Promise<{isNextPage: boolean; isPrevPage: boolean}> {
    const systemPrompt = `
You are a semantic analyzer for a task management bot.
Determine if the user's query implies they want to navigate to the next or previous page of a list.

Return a JSON object:
{
  "isNextPage": boolean,
  "isPrevPage": boolean
}

Examples returning {"isNextPage": true, "isPrevPage": false}:
- "下一页"
- "继续看"
- "再看十个"
- "后面的任务"
- "next"

Examples returning {"isNextPage": false, "isPrevPage": true}:
- "上一页"
- "看前面的"
- "prev"

Examples returning {"isNextPage": false, "isPrevPage": false}:
- "当前有哪些任务"
- "我的任务"
`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userMessage},
        ],
        true // JSON mode
      );

      const parsed = JSON.parse(response.content || '{}');
      return {
        isNextPage: !!parsed.isNextPage,
        isPrevPage: !!parsed.isPrevPage,
      };
    } catch (e) {
      this.logger.error('Failed to parse analyzePaginationIntent response', e);
      return {isNextPage: false, isPrevPage: false};
    }
  }

  async generateProjectMonthlySummary(projectName: string, year: number, month: number, tasks: any[]): Promise<string> {
    const systemPrompt = `
You are a project manager. Your task is to write a monthly summary report for the project "${projectName}" for the period of ${year}-${month}.

You are provided with a list of tasks that were active, created, updated, or completed during this month.
Analyze the tasks and provide a concise, professional, and well-structured summary.

Requirements:
- Highlight key achievements (completed tasks).
- Mention ongoing work (developing/testing tasks).
- Keep it professional, easy to read, and structured (use markdown bullet points).
- If the task list is empty, simply state that there was no recorded activity for this project in this month.

Output ONLY the report content in Markdown format. Do not output JSON.
`;

    const userContent =
      tasks.length > 0
        ? `Tasks for ${year}-${month}:\n${JSON.stringify(tasks, null, 2)}`
        : `No tasks found for ${year}-${month}.`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: userContent},
        ],
        false
      );

      return response.content || 'Failed to generate report, please try again later.';
    } catch (e) {
      this.logger.error('Failed to generate project monthly summary', e);
      return 'An error occurred while generating the report.';
    }
  }

  async isSwitchModelRequest(replyText: string): Promise<boolean> {
    const systemPrompt = `
You are a semantic analyzer. Your task is to determine if the given text is telling the user that they need to switch the AI model from the "Admin Panel" or "management console" or if the request to switch models was rejected/intercepted.

Return a JSON object:
{
  "isSwitchRequest": boolean
}

Examples of text that should return true:
- "Please change the model in the management console."
- "You cannot switch models here, please go to the management console."
- "Switching to model xxx via chat is currently not supported."

Examples of text that should return false:
- "Hello, I am the assistant."
- "Task created."
- "Please provide more details."
- "This model features..."
`;

    try {
      const response = await this.callLLM(
        [
          {role: 'system', content: systemPrompt},
          {role: 'user', content: replyText},
        ],
        true // JSON mode
      );

      const parsed = JSON.parse(response.content || '{}');
      return !!parsed.isSwitchRequest;
    } catch (e) {
      this.logger.error('Failed to parse isSwitchModelRequest response', e);
      return false;
    }
  }

  async chat(message: string, history: any[] = []): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a helpful assistant. You have access to the following skills:
${JSON.stringify(this.skillRegistry.getAllSkills())}
If the user asks to perform an action that matches a skill, use the tool call.
CRITICAL INSTRUCTIONS: 
1. If the user wants to update/delete multiple tasks, you MUST generate multiple tool calls (one for each task).
2. NEVER output tool calls as plain text or JSON in the message content. ALWAYS use the proper tool calling format.
3. After executing any tool calls, you MUST formulate a clear, human-readable natural language response to summarize the operations.
EXCEPTION TO RULE 3: If you just executed the \`queryTasks\`, \`getTaskDetail\`, \`queryProjects\`, \`queryMonthlyReport\`, \`triggerMonthlyReportGeneration\`, or \`queryWeeklyReport\` skill and you want to show the results to the user, DO NOT formulate a natural language response. Instead, JUST output the RAW JSON string returned by the tool. The system will intercept it and format it into a UI card.
`,
      },
      ...history,
      {role: 'user', content: message},
    ];

    const tools: any[] = this.skillRegistry.getAllSkills().map(skill => ({
      type: 'function',
      function: {
        name: skill.name,
        description: skill.description,
        parameters: skill.parameters,
      },
    }));

    let response = await this.callLLM(messages, false, tools);

    // A loop to handle potential multiple rounds of tool calling
    // For example: the LLM might first call queryTasks, get the result, and THEN call updateTaskStatus
    let maxToolRounds = 3;
    while (response.tool_calls && response.tool_calls.length > 0 && maxToolRounds > 0) {
      maxToolRounds--;
      const executedToolResults: {name: string; content: string}[] = [];

      // Add the assistant's initial response (which includes the tool calls) to the history
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: response.tool_calls,
      });

      // Execute ALL tool calls in parallel or sequentially
      for (const toolCall of response.tool_calls) {
        const functionName = toolCall.function.name;
        let functionArgs = {};

        try {
          if (typeof toolCall.function.arguments === 'string') {
            // DeepSeek and some models might return a messy string with markers like ✿ARGS✿: {...}
            let argsStr = toolCall.function.arguments;
            const argsMarker = '✿ARGS✿:';
            if (argsStr.includes(argsMarker)) {
              argsStr = argsStr.split(argsMarker)[1].trim();
            }

            // Always try to extract the JSON block to remove leading/trailing garbage
            const match = argsStr.match(/\{[\s\S]*\}/);
            if (match) {
              argsStr = match[0];
            }

            // The replace below might break properly escaped newlines like \n (which are literally two characters \ and n in the string).
            // But if the LLM outputted actual raw newline characters (like \n as a single character), we want to escape it.
            // A safer approach for escaping actual control characters without double-escaping already escaped ones:
            // JSON.parse can handle properly formatted strings. It only fails if there are unescaped control characters.
            // Using a custom replacer that targets actual control characters:
            const escapedArgsStr = argsStr.replace(/[\n\r\t]/g, match => {
              if (match === '\n') return '\\n';
              if (match === '\r') return '\\r';
              if (match === '\t') return '\\t';
              return match;
            });

            functionArgs = JSON.parse(escapedArgsStr);
          } else {
            functionArgs = toolCall.function.arguments;
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.logger.error(`Failed to parse tool arguments: ${toolCall.function.arguments}. Error: ${message}`);
          // Instead of continuing and ignoring the tool call, let's pass an error to the LLM so it knows it messed up
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify({
              error:
                'Failed to parse tool arguments. Ensure arguments are a valid JSON object. Do NOT include markdown, text, or markers like ✿ARGS✿.',
            }),
          });
          continue; // Skip execution but the error is recorded in history
        }

        this.logger.log(`Executing skill: ${functionName} with args: ${JSON.stringify(functionArgs)}`);

        try {
          const result = await this.skillRegistry.executeSkill(functionName, functionArgs);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

          // If the skill is one of the query skills that should return raw JSON for UI rendering,
          // we can short-circuit the LLM loop and return the raw JSON directly to the orchestrator.
          const uiRenderingSkills = [
            'queryTasks',
            'getTaskDetail',
            'queryProjects',
            'queryWeeklyReport',
            'queryMonthlyReport',
          ];
          if (uiRenderingSkills.includes(functionName)) {
            // Some models might wrap the JSON string with additional markdown or text, but here `result`
            // is exactly what the tool function returns (which is already a JSON string from task.skills.ts).
            // By returning it directly, we guarantee the orchestrator receives the pristine JSON.
            // We prepend a special marker to ensure orchestrator knows this is a short-circuited tool result
            // rather than a hallucinated JSON from the LLM.
            // It is critical to completely break out and return ONLY this marker + JSON.
            return `__TOOL_RAW_RESULT__\n${resultStr}`;
          }

          executedToolResults.push({name: functionName, content: resultStr});
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName,
            content: resultStr,
          });
        } catch (error: any) {
          this.logger.error(`Skill execution failed: ${error?.message}`);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify({error: `Failed to execute action: ${error?.message}`}),
          });
        }
      }

      // After all tool calls are executed, call LLM again
      // The LLM might either return a final text response, OR decide to call more tools
      try {
        response = await this.callLLM(messages, false, tools);
      } catch (error: any) {
        if (executedToolResults.length === 1) {
          const single = executedToolResults[0];
          try {
            const parsed = JSON.parse(single.content || '{}');
            if (typeof parsed?.message === 'string' && parsed.message.trim()) {
              return parsed.message;
            }
            if (parsed?.success === true) {
              return '✅ 操作已执行成功。';
            }
          } catch (e) {}
          return '✅ 操作已执行成功。';
        }

        if (executedToolResults.length > 1) {
          let successCount = 0;
          for (const r of executedToolResults) {
            try {
              const parsed = JSON.parse(r.content || '{}');
              if (parsed?.success === true) successCount++;
            } catch (e) {}
          }
          if (successCount > 0) {
            return `✅ 已执行 ${executedToolResults.length} 个操作（成功 ${successCount} 个）。`;
          }
          return `✅ 已执行 ${executedToolResults.length} 个操作。`;
        }

        const msg = error?.message || String(error);
        this.logger.error(`Error calling LLM after tool execution: ${msg}`, error?.stack);
        return '抱歉，系统内部出现错误，请稍后再试。';
      }
    }

    return response.content || '';
  }

  async parseFeedback(input: string): Promise<{score: number; comment: string}> {
    const systemPrompt = `
You are a feedback parser. Analyze the user's input and extract a rating score (1-5) and any additional comments.
If no explicit score is given but the sentiment is positive, default to 5. If negative, default to 1. If neutral/unclear, default to 3.

Return a JSON object:
{
  "score": number (1 to 5),
  "comment": string (the user's text, or summary of their feedback)
}
`;
    const response = await this.callLLM(
      [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: input},
      ],
      true
    );

    try {
      const parsed = JSON.parse(response.content || '{}');
      return {
        score: typeof parsed.score === 'number' && parsed.score >= 1 && parsed.score <= 5 ? parsed.score : 5,
        comment: parsed.comment || input,
      };
    } catch (e) {
      return {score: 5, comment: input};
    }
  }
}
