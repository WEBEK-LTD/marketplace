import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { ApiEnv } from '../config/env.js';
import { FoundationController } from './foundation.controller.js';
import { InternalCredentialGuard } from './internal-credential.guard.js';

/**
 * The `/v1` boundary.
 *
 * The credential guard is registered with `APP_GUARD` rather than on the controller, so it covers every
 * `/v1` route by construction — including routes added later by someone who forgets to decorate them.
 * It decides by path, so `/health` and `/ready`, which live outside `/v1`, pass straight through.
 */
@Module({})
export class V1Module {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: V1Module,
      controllers: [FoundationController],
      providers: [
        { provide: APP_GUARD, useFactory: () => new InternalCredentialGuard(env.internalBffCredentials) },
      ],
    };
  }
}
