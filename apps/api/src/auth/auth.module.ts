import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from '../config/env.js';
import { AppSystemStore } from './app-system.store.js';
import { LOGIN_ENFORCEMENT_STORE, LoginEnforcementService } from './login-enforcement.service.js';
import { OtpPepper } from './otp/otp-digest.js';
import { OTP_CHALLENGE_STORE, OTP_PEPPER, OtpService } from './otp/otp.service.js';
import { WaabekClient } from './otp/waabek.client.js';
import { STEP_UP_STORE, StepUpService } from './step-up/step-up.service.js';

/**
 * Authentication enforcement (Phase 3 Step 1).
 *
 * The module provides the durable lockout gate and nothing else: no controller, no Supabase client, no
 * session. Under owner Decision 1 (Option B) every authentication operation stays behind NestJS, and
 * this is the first piece of that boundary — the check that must run before Supabase is ever called.
 */
@Module({})
export class AuthModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          // One pool, shared by both consumers: the store implements both narrow interfaces.
          provide: AppSystemStore,
          useFactory: () =>
            AppSystemStore.fromConnectionString(
              env.appSystemDatabaseUrl,
              env.appSystemDatabaseMaxConnections,
            ),
        },
        { provide: LOGIN_ENFORCEMENT_STORE, useExisting: AppSystemStore },
        { provide: OTP_CHALLENGE_STORE, useExisting: AppSystemStore },
        { provide: STEP_UP_STORE, useExisting: AppSystemStore },
        { provide: OTP_PEPPER, useFactory: () => new OtpPepper(env.otpPepper) },
        {
          provide: WaabekClient,
          useFactory: () => new WaabekClient({ baseUrl: env.waabekBaseUrl, apiKey: env.waabekApiKey }),
        },
        LoginEnforcementService,
        OtpService,
        StepUpService,
      ],
      exports: [LoginEnforcementService, OtpService, StepUpService],
    };
  }
}
