import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ToolRegistryService } from './tool-registry.service';
import { EchoTool } from './tools/echo.tool';
import { ReadFileTool } from './tools/read-file.tool';

/**
 * Registers the built-in tools into the registry on boot. @Global so AgentRunner
 * can inject ToolRegistryService. Add new tools by registering them here.
 */
@Global()
@Module({
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolsModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(new EchoTool());
    this.registry.register(new ReadFileTool(this.config.toolWorkspaceRoot));
  }
}
