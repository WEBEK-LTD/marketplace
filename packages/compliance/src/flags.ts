/**
 * Provisional feature flags. Every one is closed, and none of them can open a financial or disclosure path.
 *
 * Two deliberate choices here.
 *
 * **They are code constants, not database settings.** A seeded settings key is effectively permanent —
 * removing one later is a contract migration — so putting these in `site_settings` would have pre-empted
 * BC-06 Part 2, which is the open question of who may authorise the settlement posting gate. Flags in code
 * can be deleted in a single commit.
 *
 * **They are read-surface flags only.** No flag here gates a money-moving operation or a disclosure, because
 * a flag that could do either would be a second route to the thing the blockers exist to prevent. The one
 * real gate on settlement posting remains `finance.settlement_posting_enabled` in the database, which is
 * unchanged and remains false; the one real gate on destination disclosure is that no disclosure path exists.
 * The test suite asserts that no flag name matches the vocabulary of a forbidden operation.
 */

export const PROVISIONAL_FEATURE_FLAGS = Object.freeze({
  /** Whether the compliance register is exposed on an administrative read surface. */
  complianceRegisterReadSurface: false,
  /** Whether the processing-purpose register is exposed on an administrative read surface. */
  processingPurposeReadSurface: false,
  /** Whether the retention policy layer is exposed on an administrative read surface. */
  retentionPolicyReadSurface: false,
  /** Whether a surface exists for recording a received counsel finding against a rule. */
  counselFindingIntakeSurface: false,
} as const);

export type ProvisionalFeatureFlag = keyof typeof PROVISIONAL_FEATURE_FLAGS;

export const PROVISIONAL_FEATURE_FLAG_NAMES = Object.freeze(
  Object.keys(PROVISIONAL_FEATURE_FLAGS) as readonly ProvisionalFeatureFlag[],
);

/** Reads a flag. Every flag is closed in the provisional baseline. */
export function isFlagOpen(flag: ProvisionalFeatureFlag): boolean {
  return PROVISIONAL_FEATURE_FLAGS[flag];
}

/** Whether any flag is open. The test suite asserts this is false. */
export function anyFlagOpen(): boolean {
  return PROVISIONAL_FEATURE_FLAG_NAMES.some((flag) => PROVISIONAL_FEATURE_FLAGS[flag]);
}
