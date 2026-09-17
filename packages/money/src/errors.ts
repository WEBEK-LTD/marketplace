export type MoneyErrorCode =
  | 'INVALID_CURRENCY_CODE'
  | 'INVALID_MINOR_UNIT'
  | 'INVALID_CURRENCY_DEFINITION'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_AMOUNT'
  | 'OUT_OF_RANGE'
  | 'INVALID_DECIMAL'
  | 'EXCESS_PRECISION'
  | 'INVALID_PERCENTAGE'
  | 'INVALID_WEIGHTS'
  | 'INVALID_JSON'
  | 'UNKNOWN_CURRENCY';

/** The only error type thrown by this package for invalid input or unsafe results. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}
