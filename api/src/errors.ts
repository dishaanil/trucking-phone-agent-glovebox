/** An error with an HTTP status and a short, speakable message the agent can say as-is. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
