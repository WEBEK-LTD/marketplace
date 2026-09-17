import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessResponse } from '@repo/contracts';

/** A dependency check reported by /ready. Checks are added in later steps (Redis, database). */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<boolean>;
}

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

@Injectable()
export class ReadinessService {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: readonly ReadinessCheck[]) {}

  async evaluate(): Promise<ReadinessResponse> {
    const results = await Promise.all(
      this.checks.map(async (item) => {
        let ok = false;
        try {
          ok = (await item.check()) === true;
        } catch {
          ok = false;
        }
        return { name: item.name, status: ok ? ('ok' as const) : ('failed' as const) };
      }),
    );
    return {
      status: results.every((result) => result.status === 'ok') ? 'ready' : 'not_ready',
      checks: results,
    };
  }
}
