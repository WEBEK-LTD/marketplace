import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from './env.js';

export const API_ENV = Symbol('API_ENV');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: API_ENV, useValue: env }],
      exports: [API_ENV],
    };
  }
}
