/** Exit codes, documented in the README and the agent skill. */
export const EXIT = {
  OK: 0,
  USAGE: 2,
  AUTH: 3,
  CREDITS: 4,
  FAILED: 5,
  NETWORK: 6,
  NOT_READY: 7,
} as const;

/** Extra fields the server may send next to an error's code and message. */
export interface ErrorDetails {
  /** Sending the same request again later may work. */
  retryable?: boolean;
  /** A safety filter refused the prompt or an image. */
  requiresPromptRevision?: boolean;
  /** A model of the same kind whose default request fits the balance. */
  suggestedModel?: string;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(
    message: string,
    exitCode: number,
    code = 'ERROR',
    details: ErrorDetails = {}
  ) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
  }
}

/** One short line on what to do next, from the server's error details. */
export function errorHint(error: CliError): string | undefined {
  const { retryable, requiresPromptRevision, suggestedModel } = error.details;
  const parts: string[] = [];
  if (requiresPromptRevision) {
    parts.push('Change the prompt or reference images before trying again.');
  } else if (retryable) {
    parts.push('Trying again later may work.');
  }
  if (suggestedModel) {
    parts.push(`\`--model ${suggestedModel}\` fits your balance.`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/** What the CLI writes to stderr for a failed command. */
export function formatError(error: CliError, json: boolean): string {
  if (json) {
    return JSON.stringify({
      error: { code: error.code, message: error.message, ...error.details },
    });
  }
  const hint = errorHint(error);
  return `Error: ${error.message}${hint ? `\nHint: ${hint}` : ''}`;
}

const EXIT_BY_CODE: Record<string, number> = {
  unauthorized: EXIT.AUTH,
  email_not_verified: EXIT.AUTH,
  insufficient_credits: EXIT.CREDITS,
  upgrade_required: EXIT.CREDITS,
  busy: EXIT.CREDITS,
  generation_failed: EXIT.FAILED,
  unavailable: EXIT.NETWORK,
  internal: EXIT.NETWORK,
};

/** Exit code for an API error code; other 4xx codes are input problems. */
export function exitCodeFor(code: string, status: number): number {
  return EXIT_BY_CODE[code] ?? (status >= 500 ? EXIT.NETWORK : EXIT.USAGE);
}
