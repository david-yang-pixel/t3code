import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { HostedWorkspaceId } from "@t3tools/contracts";

import * as HostedWorkspace from "../workspace/HostedWorkspace.ts";

const workspaceIdArgument = Argument.String("workspace-id");
const decodeId = Schema.decodeEffect(HostedWorkspaceId);

class HostedCommandFailed extends CliError.UserError {
  override get message(): string {
    return "The command failed in the hosted workspace.";
  }
}

const create = Command.make("create", {
  repository: Argument.String("owner/repository"),
  branch: Flag.String("branch").pipe(Flag.optional),
  image: Flag.String("image").pipe(Flag.withDefault("node:24-bookworm")),
}).pipe(
  Command.withDescription("Create a Docker workspace and clone a public GitHub repository."),
  Command.withHandler(({ repository, branch, image }) =>
    Effect.gen(function* () {
      const workspaces = yield* HostedWorkspace.HostedWorkspace;
      const workspaceId = yield* workspaces.create({
        repository,
        image,
        ...Option.match(branch, { onNone: () => ({}), onSome: (value) => ({ branch: value }) }),
      });
      yield* Console.log(workspaceId);
    }).pipe(Effect.provide(HostedWorkspace.layer)),
  ),
);

const status = Command.make("status", { workspaceId: workspaceIdArgument }).pipe(
  Command.withDescription("Show the container and data volume status."),
  Command.withHandler(({ workspaceId }) =>
    Effect.gen(function* () {
      const workspaces = yield* HostedWorkspace.HostedWorkspace;
      const id = yield* decodeId(workspaceId);
      yield* Console.log(yield* workspaces.status(id));
    }).pipe(Effect.provide(HostedWorkspace.layer)),
  ),
);

const run = Command.make("run", {
  workspaceId: workspaceIdArgument,
  executable: Argument.String("executable"),
  args: Argument.String("arg").pipe(Argument.variadic()),
}).pipe(
  Command.withDescription("Run a command in the hosted repository directory."),
  Command.withHandler(({ workspaceId, executable, args }) =>
    Effect.gen(function* () {
      const workspaces = yield* HostedWorkspace.HostedWorkspace;
      const id = yield* decodeId(workspaceId);
      const result = yield* workspaces.run(id, [executable, ...args]);
      if (result.stdout !== "") yield* Console.log(result.stdout.trimEnd());
      if (result.stderr !== "") yield* Console.error(result.stderr.trimEnd());
      if (result.truncated) yield* Console.error("Command output was truncated.");
      if (result.exitCode !== 0) return yield* new HostedCommandFailed({ cause: result.exitCode });
    }).pipe(Effect.provide(HostedWorkspace.layer)),
  ),
);

export const hostedWorkspaceCommand = Command.make("hosted-workspace").pipe(
  Command.withDescription("Manage per-session Docker working directories on this host."),
  Command.withSubcommands([
    create,
    status,
    run,
    ...(
      [
        ["start", "start", "Restart a workspace with its existing files."],
        ["stop", "stop", "Stop a workspace while retaining its files."],
        ["delete", "remove", "Permanently delete a workspace and its data volume."],
      ] as const
    ).map(([name, method, description]) =>
      Command.make(name, { workspaceId: workspaceIdArgument }).pipe(
        Command.withDescription(description),
        Command.withHandler(({ workspaceId }) =>
          Effect.gen(function* () {
            const workspaces = yield* HostedWorkspace.HostedWorkspace;
            yield* workspaces[method](yield* decodeId(workspaceId));
          }).pipe(Effect.provide(HostedWorkspace.layer)),
        ),
      ),
    ),
  ]),
);
