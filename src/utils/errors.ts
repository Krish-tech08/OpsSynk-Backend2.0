/** Application error with a stable machine-readable code and a safe client message. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 500,
    public readonly details?: unknown,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (details: unknown) => new AppError("VALIDATION_FAILED", "The request is invalid.", 400, details),
  unauthenticated: (msg = "Authentication is required.") => new AppError("UNAUTHENTICATED", msg, 401),
  forbidden: (msg = "You do not have permission to perform this action.") => new AppError("FORBIDDEN", msg, 403),
  notFound: (what = "Resource") => new AppError("NOT_FOUND", `${what} was not found.`, 404),
  conflict: (msg: string) => new AppError("CONFLICT", msg, 409),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError("RATE_LIMITED", "Too many requests. Try again later.", 429, { retryAfterSeconds }),
  invalidMapping: (details: unknown) =>
    new AppError("INVALID_REPOSITORY_MAPPING", "One or more repositories cannot be mapped to this project.", 400, details),
  githubUnavailable: (msg = "GitHub data is temporarily unavailable.", retryable = true) =>
    new AppError("GITHUB_UNAVAILABLE", msg, 502, undefined, retryable),
  githubRateLimited: (resetAt?: string) =>
    new AppError("GITHUB_RATE_LIMITED", "GitHub rate limit reached. Try again later.", 503, { resetAt }),
  geminiUnavailable: (msg = "AI analysis is temporarily unavailable.") => new AppError("GEMINI_UNAVAILABLE", msg, 503),
  geminiRateLimited: () => new AppError("GEMINI_RATE_LIMITED", "AI analysis is temporarily unavailable.", 503),
  modelBudgetExceeded: (limit: number) =>
    new AppError("MODEL_BUDGET_EXCEEDED", `The model-call budget of ${limit} calls was reached.`, 429, { limit }),
  invalidModelOutput: () => new AppError("INVALID_MODEL_OUTPUT", "The AI response did not match the expected format.", 502),
  toolBudgetExceeded: (limit: number) =>
    new AppError("TOOL_BUDGET_EXCEEDED", `The tool-call budget of ${limit} calls was reached.`, 429, { limit }),
  timeout: (what: string) => new AppError("TIMEOUT", `${what} timed out.`, 504),
};

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
