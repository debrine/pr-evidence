/** A failure the caller can act on. `code` is stable; `message` is for people. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
