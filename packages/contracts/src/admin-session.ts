import { z } from './zod.js';

/**
 * The staff console session (Phase 7-F).
 *
 * One read, and it answers the only three questions the admin shell asks before it renders anything:
 * who is this, have they reached the assurance level staff work requires, and what may they see.
 *
 * Several shapes here are decisions rather than conveniences.
 *
 *   * **No request names an account, and no request names a permission.** There is no request schema in
 *     this module at all — the operation takes nothing but the caller's own session. A browser cannot
 *     ask about somebody else, and cannot assert what it is allowed to do: `permissions` travels one
 *     way, from the database to the screen, and is never read back from a request anywhere in 7-F.
 *   * **`permissions` is the caller's effective set, already filtered.** The assurance rule is applied
 *     in the database, by the same predicate `public.has_permission` uses, so a staff member who has not
 *     completed a second factor receives an **empty** array rather than a full one plus a flag. There is
 *     no arrangement in which a client could combine the two fields wrongly and show something.
 *   * **`requiresStepUp` is not a permission.** It distinguishes the two refusals the shell handles
 *     differently — staff who must complete the existing TOTP challenge, and everybody else, who gets
 *     the neutral refusal. It says nothing about what the person could do afterwards.
 *   * **Nothing here is writable.** There is no role field a client could send back, no permission
 *     grant, no assurance assertion. The console reads this and renders; it changes nothing about the
 *     account it is describing.
 */

/** The four staff roles 0003 defines and 0033 seeds. 7-F adds none and the shell recognises no others. */
export const STAFF_ROLES = ['support_agent', 'moderator', 'admin', 'super_admin'] as const;
export const StaffRoleSchema = z.enum(STAFF_ROLES).openapi('StaffRole');

/**
 * A permission key, in the `module.subject.action` form `permissions_key_format` enforces.
 *
 * Validated by **shape**, not against a list: the keys are rows in `public.permissions`, seeded by 0033
 * and owned by the database. A hard-coded enumeration here would be a second copy of that table, and a
 * key added there would make this schema refuse a truthful answer.
 */
export const PermissionKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  .max(120)
  .openapi('PermissionKey');

/**
 * What the console knows about the person using it.
 *
 * `displayName` is the same field `GET /v1/users/me` already returns — the account area shows a name,
 * and nothing else about the person is needed to render a shell. No email, no phone, no verification
 * state: an admin header is not a profile page.
 */
export const AdminSessionSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().nullable(),
    /** The person's interface language, from their own profile. `null` means follow the default. */
    localeCode: z.string().max(35).nullable(),
    /** Whether the account holds a console role at all, before the assurance rule is applied. */
    isStaff: z.boolean(),
    /** Staff who have not reached aal2. Never true for somebody who is not staff. */
    requiresStepUp: z.boolean(),
    /** Effective roles, with the assurance rule already applied. Empty for staff at aal1. */
    roles: z.array(StaffRoleSchema),
    /** Effective permissions, with the assurance rule already applied. Empty for staff at aal1. */
    permissions: z.array(PermissionKeySchema),
  })
  .strict()
  .openapi('AdminSession');

export const AdminSessionResponseSchema = z
  .object({ session: AdminSessionSchema })
  .strict()
  .openapi('AdminSessionResponse');

export type StaffRole = z.infer<typeof StaffRoleSchema>;
export type AdminSession = z.infer<typeof AdminSessionSchema>;
export type AdminSessionResponse = z.infer<typeof AdminSessionResponseSchema>;
