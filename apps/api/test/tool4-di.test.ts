import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

// TOOL-4: NestJS constructor injection by type relies on emitted decorator metadata.
@Injectable()
class Clock {
  now(): string {
    return 'fixed-time';
  }
}

@Injectable()
class Greeter {
  constructor(private readonly clock: Clock) {}

  greet(): string {
    return `hello at ${this.clock.now()}`;
  }
}

@Module({ providers: [Clock, Greeter] })
class GreetingModule {}

describe('TOOL-4: NestJS dependency injection under Vitest', () => {
  it('emits design:paramtypes metadata', () => {
    expect(Reflect.getMetadata('design:paramtypes', Greeter)).toEqual([Clock]);
  });

  it('resolves constructor dependencies by type', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GreetingModule] }).compile();
    expect(moduleRef.get(Greeter).greet()).toBe('hello at fixed-time');
    await moduleRef.close();
  });
});
