/** An expected, user-correctable problem. Its message is safe to show as-is. */
export class UserError extends Error {
  constructor(message, extra = {}) { super(message); this.name = 'UserError'; Object.assign(this, extra); }
}
/** The action would reverse dependent records; the caller must confirm first. */
export class ConfirmError extends UserError {
  constructor(message, extra = {}) { super(message, extra); this.name = 'ConfirmError'; }
}
/** The workspace changed underneath us (another tab). Nothing was written. */
export class ConflictError extends Error {
  constructor(message = 'This workspace was changed in another tab. Reload to continue.') { super(message); this.name = 'ConflictError'; }
}
