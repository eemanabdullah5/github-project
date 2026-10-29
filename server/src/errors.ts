/**
 * An error whose message is safe to show to the user (PRD NFR-8).
 * Modules throw this for expected problems: not found, rate limit, size limit, etc.
 * Any other error is treated as unexpected and shown as a generic message.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}
