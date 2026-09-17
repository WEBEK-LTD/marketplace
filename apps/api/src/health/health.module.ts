import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { READINESS_CHECKS, ReadinessService, type ReadinessCheck } from './readiness.js';

const NO_CHECKS: readonly ReadinessCheck[] = Object.freeze([]);

@Module({
  controllers: [HealthController],
  providers: [ReadinessService, { provide: READINESS_CHECKS, useValue: NO_CHECKS }],
})
export class HealthModule {}
