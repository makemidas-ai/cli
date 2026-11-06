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

export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(message: string, exitCode: number, code = 'ERROR') {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
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
