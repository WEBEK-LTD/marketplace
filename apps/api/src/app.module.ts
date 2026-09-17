import { Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { ApiEnv } from './config/env.js';
import { HealthModule } from './health/health.module.js';

@Module({})
export class AppModule implements OnApplicationShutdown {
  private readonly logger = new Logger('Shutdown');

  onApplicationShutdown(signal?: string): void {
    this.logger.log(`Shutdown complete${signal === undefined ? '' : ` (${signal})`}`);
  }

  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(env), HealthModule],
    };
  }
}
