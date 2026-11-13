import { ErrorCode, RpcError } from "@frameshell/protocol";

const BINARY_ERRORS: readonly number[] = [ErrorCode.BinaryUnavailable, ErrorCode.BinaryNotFound, ErrorCode.BinaryInstallFailed, ErrorCode.BinaryChecksumMismatch];

/** True for the `Binary*` errors of a managed tool that could not be fetched or run: nothing was measured, so callers fail instead of treating the file as unreadable. */
export function isBinaryError(error: unknown): error is RpcError {
  return error instanceof RpcError && BINARY_ERRORS.includes(error.code);
}
