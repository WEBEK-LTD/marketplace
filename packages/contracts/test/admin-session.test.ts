import { describe, expect, it } from 'vitest';
import {
  AdminSessionResponseSchema,
  AdminSessionSchema,
  PermissionKeySchema,
  STAFF_ROLES,
  generateOpenApiDocument,
} from '../src/index.js';

/**
 * Phase 7-F — the staff console session contract.
 *
 * The assertions that matter are about absence. This is the shape every authorization decision in the
 * admin shell is made from, so what it must not carry matters more than what it does: no account a
 * request could name, no unfiltered permission set beside a flag, no assurance level a browser could
 * assert, and nothing writable.
 */

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Nadia',
  localeCode: 'en',
  isStaff: true,
  requiresStepUp: false,
  roles: ['moderator'],
  permissions: ['moderation.report.read', 'reviews.review.read'],
};

describe('7-F the console session', () => {
  it('accepts the shape the shell renders', () => {
    expect(AdminSessionSchema.safeParse(SESSION).success).toBe(true);
    expect(AdminSessionResponseSchema.safeParse({ session: SESSION }).success).toBe(true);
  });

  it('accepts the four staff roles and no others', () => {
    expect(STAFF_ROLES).toEqual(['support_agent', 'moderator', 'admin', 'super_admin']);
    for (const role of STAFF_ROLES) {
      expect(AdminSessionSchema.safeParse({ ...SESSION, roles: [role] }).success, role).toBe(true);
    }
    for (const role of ['root', 'owner', 'superuser', 'buyer', 'seller', 'staff']) {
      expect(AdminSessionSchema.safeParse({ ...SESSION, roles: [role] }).success, role).toBe(false);
    }
  });

  it('validates a permission by shape, because the keys are the database’s', () => {
    for (const key of ['audit.read', 'catalog.listing.moderate', 'settings.email_template.manage']) {
      expect(PermissionKeySchema.safeParse(key).success, key).toBe(true);
    }
    for (const key of ['audit', 'Audit.read', 'audit.', '.read', 'audit read', 'DROP TABLE', '', 'a'.repeat(200)]) {
      expect(PermissionKeySchema.safeParse(key).success, key).toBe(false);
    }
  });

  it('carries no account a request could name, and no secret', () => {
    for (const field of ['userId', 'accessToken', 'token', 'aal', 'email', 'phoneE164', 'password']) {
      expect(AdminSessionSchema.safeParse({ ...SESSION, [field]: 'x' }).success, field).toBe(false);
    }
  });

  it('carries no unfiltered permission set beside the effective one', () => {
    for (const field of ['allPermissions', 'rawPermissions', 'grantedPermissions', 'effectivePermissions']) {
      expect(AdminSessionSchema.safeParse({ ...SESSION, [field]: [] }).success, field).toBe(false);
    }
    // One permissions field, and it is the effective one.
    const keys = Object.keys(AdminSessionSchema.shape);
    expect(keys.filter((key) => key.toLowerCase().includes('permission'))).toEqual(['permissions']);
  });

  it('describes staff at aal1 as holding nothing', () => {
    const steppedDown = { ...SESSION, requiresStepUp: true, roles: [], permissions: [] };
    expect(AdminSessionSchema.safeParse(steppedDown).success).toBe(true);
  });

  it('describes somebody who is not staff with the same shape', () => {
    const buyer = { ...SESSION, isStaff: false, requiresStepUp: false, roles: [], permissions: [] };
    expect(AdminSessionSchema.safeParse(buyer).success).toBe(true);
  });

  it('is the only admin shape, and none of it is a request', async () => {
    const module = await import('../src/admin-session.js');
    const exported = Object.keys(module);
    for (const name of exported) {
      expect(name.toLowerCase(), name).not.toContain('request');
      expect(name.toLowerCase(), name).not.toContain('update');
      expect(name.toLowerCase(), name).not.toContain('grant');
      expect(name.toLowerCase(), name).not.toContain('assign');
    }
  });
});

describe('7-F the documented operation', () => {
  const doc = generateOpenApiDocument();

  it('documents one session operation, and it is a read', () => {
    // 7-G added the seller verification review operations under the same prefix; the property this test
    // holds is about the *session* operation, which stays a single read that writes nothing.
    const sessionPaths = Object.keys(doc.paths ?? {}).filter((path) => path.startsWith('/v1/admin/session'));
    expect(sessionPaths).toEqual(['/v1/admin/session']);
    expect(Object.keys(doc.paths?.['/v1/admin/session'] ?? {})).toEqual(['get']);
    expect(doc.paths?.['/v1/admin/session']?.get?.operationId).toBe('getV1AdminSession');
  });

  it('takes no parameter beyond the session header', () => {
    const operation = doc.paths?.['/v1/admin/session']?.get;
    const names = (operation?.parameters ?? []).map((parameter) =>
      'name' in parameter ? parameter.name : '',
    );
    expect(names).toEqual(['x-session-token']);
    expect(operation?.requestBody).toBeUndefined();
  });

  it('requires a session and refuses without the internal credential', () => {
    const operation = doc.paths?.['/v1/admin/session']?.get;
    expect(operation?.responses?.['401']).toBeDefined();
    expect(operation?.responses?.['403']).toBeDefined();
  });
});
