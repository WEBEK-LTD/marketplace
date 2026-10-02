import type { ProblemCode } from '@repo/contracts';

/**
 * One of a seller's answers was not one the listing can carry (Phase 8-C).
 *
 * 409 rather than 400, and a code of its own rather than `VALIDATION_FAILED`, because the request was well formed
 * and something outside it refused: an answer whose kind is not its attribute's, an option that belongs to
 * another attribute or has been hidden, more than one option on a single-select, a tag that does not exist or is
 * hidden, or an attribute this listing's category does not ask about. All of those are the state of the catalogue
 * at the moment of the write, which is what the project's 409s mean everywhere else, and none of them is anything
 * the schema could have caught from the request alone.
 *
 * 0011's validation trigger is the single judge of all of it; this class is one sentence for its refusal.
 *
 * **It is never raised for an unanswered required attribute.** `is_required` is advisory in this increment: a
 * seller is told which fields are required and nothing refuses a save or a submission for want of one.
 */
export class SellerVocabularyAnswerRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED',
  };

  constructor() {
    super('One of those answers is not one this listing can carry.');
    this.name = 'SellerVocabularyAnswerRefusedError';
  }
}
