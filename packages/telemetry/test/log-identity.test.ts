import { describe, expect, it } from 'vitest';
import {
  activeLogIdentityFields,
  currentLogIdentity,
  runInLogIdentityScope,
  setLogIdentity,
} from '../src/index.js';

/**
 * The request- and job-scoped log identity (O8-12).
 *
 * The scope is what makes one call at the top of a request reach every line the request writes, so the
 * properties worth proving are: it reaches across awaits, it does not leak between concurrent scopes,
 * and it contributes nothing at all until an identity is actually known.
 */

const ID_A = 'usr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ID_B = 'usr_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('log identity scope', () => {
  it('contributes no field outside a scope', () => {
    expect(activeLogIdentityFields()).toEqual({});
    expect(currentLogIdentity()).toBeUndefined();
  });

  it('contributes no field inside a scope until an identity is known', () => {
    runInLogIdentityScope(() => {
      expect(activeLogIdentityFields()).toEqual({});
    });
  });

  it('adds the identity to every record once it is set', () => {
    runInLogIdentityScope(() => {
      setLogIdentity(ID_A);
      expect(activeLogIdentityFields()).toEqual({ user_pseudo_id: ID_A });
      expect(currentLogIdentity()).toBe(ID_A);
    });
  });

  it('survives awaits, so a line written late in a request still carries it', async () => {
    await runInLogIdentityScope(async () => {
      setLogIdentity(ID_A);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(activeLogIdentityFields()).toEqual({ user_pseudo_id: ID_A });
    });
  });

  it('ends with its scope: one request cannot see another’s identity', async () => {
    await runInLogIdentityScope(async () => {
      setLogIdentity(ID_A);
      await Promise.resolve();
    });
    expect(activeLogIdentityFields()).toEqual({});
  });

  it('keeps concurrent scopes apart', async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all([
      runInLogIdentityScope(async () => {
        setLogIdentity(ID_A);
        await new Promise((resolve) => setTimeout(resolve, 10));
        seen.push(currentLogIdentity());
      }),
      runInLogIdentityScope(async () => {
        setLogIdentity(ID_B);
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(currentLogIdentity());
      }),
      runInLogIdentityScope(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(currentLogIdentity());
      }),
    ]);
    expect(seen.sort()).toEqual([ID_A, ID_B, undefined].sort());
  });

  it('is a no-op outside a scope, so no service can fail for want of a request', () => {
    expect(() => setLogIdentity(ID_A)).not.toThrow();
    expect(activeLogIdentityFields()).toEqual({});
  });

  it('ignores an absent or empty identity rather than writing an empty field', () => {
    runInLogIdentityScope(() => {
      setLogIdentity(undefined);
      setLogIdentity('');
      expect(activeLogIdentityFields()).toEqual({});
    });
  });
});
