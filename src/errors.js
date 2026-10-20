/**
 * @typedef {'invalid_identifier'|'invalid_option'|'wrong_secret'|'invalid_list'} DncErrorCode
 */

/** Something do-not-contact refused to do. Match on `code`. */
export class DncError extends Error {
  /**
   * @param {DncErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'DncError'
    /** @type {DncErrorCode} */
    this.code = code
  }
}
