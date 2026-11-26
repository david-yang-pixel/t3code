import * as Schema from "effect/Schema";
import { GitRefName } from "./baseSchemas.ts";

export const HostedWorkspaceId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
).pipe(Schema.brand("HostedWorkspaceId"));
export type HostedWorkspaceId = typeof HostedWorkspaceId.Type;

export const HostedGitHubRepository = Schema.String.check(
  Schema.isMaxLength(140),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
);

const HostedWorkspaceState = Schema.Literals(["running", "stopped", "partial", "absent"]);
export type HostedWorkspaceState = typeof HostedWorkspaceState.Type;

export const HostedWorkspaceCommandResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  exitCode: Schema.Int,
  truncated: Schema.Boolean,
});
export type HostedWorkspaceCommandResult = typeof HostedWorkspaceCommandResult.Type;

export const HostedWorkspaceAction = Schema.Union([
  Schema.TaggedStruct("create", {
    repository: HostedGitHubRepository,
    branch: Schema.optionalKey(GitRefName),
  }),
  Schema.TaggedStruct("manage", {
    id: HostedWorkspaceId,
    operation: Schema.Literals(["status", "start", "stop", "remove"]),
  }),
  Schema.TaggedStruct("run", {
    id: HostedWorkspaceId,
    argv: Schema.NonEmptyArray(
      Schema.String.check(Schema.isMaxLength(32768), Schema.isPattern(/^[^\0]*$/)),
    ).check(Schema.isMaxLength(128)),
  }),
]);
export type HostedWorkspaceAction = typeof HostedWorkspaceAction.Type;

export const HostedWorkspaceResult = Schema.Union([
  Schema.TaggedStruct("workspace", { id: HostedWorkspaceId, state: HostedWorkspaceState }),
  Schema.TaggedStruct("command", HostedWorkspaceCommandResult.fields),
]);
export type HostedWorkspaceResult = typeof HostedWorkspaceResult.Type;

export class HostedWorkspaceRpcError extends Schema.TaggedError<
  HostedWorkspaceRpcError,
  { readonly brand: unique symbol }
>()("HostedWorkspaceRpcError", {
  status: Schema.Literals(["unavailable", "failed"]),
  id: Schema.optionalKey(HostedWorkspaceId),
}) {
  override get message(): string {
    if (this.status === "unavailable")
      return "Hosted workspaces are unavailable on this environment.";
    return this.id === undefined
      ? "The hosted workspace operation failed."
      : `The hosted workspace operation failed for ${this.id}.`;
  }
}
