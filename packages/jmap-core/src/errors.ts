/** JMAP error machinery (RFC 8620 §3.6). */

/** Request-level problem types, returned as an HTTP-level JSON problem. */
export const RequestErrors = {
  unknownCapability: "urn:ietf:params:jmap:error:unknownCapability",
  notJSON: "urn:ietf:params:jmap:error:notJSON",
  notRequest: "urn:ietf:params:jmap:error:notRequest",
  limit: "urn:ietf:params:jmap:error:limit",
} as const;

export type MethodErrorType =
  | "serverUnavailable"
  | "serverFail"
  | "serverPartialFail"
  | "unknownMethod"
  | "invalidArguments"
  | "invalidResultReference"
  | "forbidden"
  | "accountNotFound"
  | "accountNotSupportedByMethod"
  | "accountReadOnly"
  | "requestTooLarge"
  | "cannotCalculateChanges"
  | "stateMismatch";

/**
 * Thrown inside a method handler; the dispatcher converts it into an
 * ["error", { type, description? }, callId] invocation.
 */
export class MethodError extends Error {
  readonly type: MethodErrorType;
  readonly description?: string;

  constructor(type: MethodErrorType, description?: string) {
    super(description ?? type);
    this.type = type;
    this.description = description;
  }

  toArgs(): Record<string, unknown> {
    return this.description ? { type: this.type, description: this.description } : { type: this.type };
  }
}
