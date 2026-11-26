import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  HostedGitHubRepository,
  HostedWorkspaceId,
  HostedWorkspaceRpcError,
  type HostedWorkspaceAction,
  type HostedWorkspaceCommandResult,
  type HostedWorkspaceResult,
  type HostedWorkspaceState,
} from "@t3tools/contracts";

class HostedWorkspaceError extends Schema.TaggedError<
  HostedWorkspaceError,
  { readonly brand: unique symbol }
>()("HostedWorkspaceError", {
  operation: Schema.String,
  workspaceId: HostedWorkspaceId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Could not ${this.operation} hosted workspace ${this.workspaceId}.`;
  }
}

export class HostedWorkspace extends Context.Service<
  HostedWorkspace,
  {
    readonly create: (input: {
      readonly repository: string;
      readonly image: string;
      readonly branch?: string;
    }) => Effect.Effect<HostedWorkspaceId, HostedWorkspaceError>;
    readonly status: (
      id: HostedWorkspaceId,
    ) => Effect.Effect<HostedWorkspaceState, HostedWorkspaceError>;
    readonly start: (id: HostedWorkspaceId) => Effect.Effect<void, HostedWorkspaceError>;
    readonly stop: (id: HostedWorkspaceId) => Effect.Effect<void, HostedWorkspaceError>;
    readonly remove: (id: HostedWorkspaceId) => Effect.Effect<void, HostedWorkspaceError>;
    readonly run: (
      id: HostedWorkspaceId,
      argv: readonly [string, ...string[]],
    ) => Effect.Effect<HostedWorkspaceCommandResult, HostedWorkspaceError>;
    readonly act: (
      input: HostedWorkspaceAction,
    ) => Effect.Effect<HostedWorkspaceResult, HostedWorkspaceRpcError>;
  }
>()("t3/workspace/HostedWorkspace") {}

const WORKSPACE_LABEL = "dev.t3code.hosted-workspace";
const WORKSPACE_HOME = "/home/node";
const REPOSITORY_PATH = `${WORKSPACE_HOME}/repository`;
const decodeRepository = Schema.decodeEffect(HostedGitHubRepository);
const resourceName = (id: HostedWorkspaceId) => `t3-workspace-${id}`;

export function resolveHostedWorkspaceImage(platform: string, environment: NodeJS.ProcessEnv) {
  return platform === "linux" ? environment.T3CODE_HOSTED_WORKSPACE_IMAGE?.trim() || null : null;
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const configuredImage = resolveHostedWorkspaceImage(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );

  const docker = Effect.fn("HostedWorkspace.docker")(function* (
    id: HostedWorkspaceId,
    operation: string,
    args: ReadonlyArray<string>,
    timeout: "30 seconds" | "15 minutes" = "30 seconds",
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make("docker", args, { stdin: "ignore", forceKillAfter: "2 seconds" }),
        );
        const { stdout, stderr, exitCode } = yield* Effect.all(
          {
            stdout: collectUint8StreamText({ stream: child.stdout, maxBytes: 512 * 1024 }),
            stderr: collectUint8StreamText({ stream: child.stderr, maxBytes: 128 * 1024 }),
            exitCode: child.exitCode,
          },
          { concurrency: "unbounded" },
        );
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          truncated: stdout.truncated || stderr.truncated,
        };
      }),
    ).pipe(
      Effect.timeout(timeout),
      Effect.mapError((cause) => new HostedWorkspaceError({ workspaceId: id, operation, cause })),
    );
  });

  const checkedDocker = Effect.fn("HostedWorkspace.checkedDocker")(function* (
    ...args: Parameters<typeof docker>
  ) {
    const [workspaceId, operation] = args;
    const result = yield* docker(...args);
    if (result.exitCode !== 0) {
      return yield* new HostedWorkspaceError({ workspaceId, operation, cause: result.stderr });
    }
    return result.stdout.trim();
  });

  const lookup = Effect.fn("HostedWorkspace.lookup")(function* (id: HostedWorkspaceId) {
    const label = `label=${WORKSPACE_LABEL}=${id}`;
    const name = resourceName(id);
    const [row, volumeName] = yield* Effect.all(
      [
        checkedDocker(id, "inspect", [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `name=^/${name}$`,
          "--filter",
          label,
          "--format",
          "{{.ID}} {{.State}}",
        ]),
        checkedDocker(id, "inspect", [
          "volume",
          "ls",
          "--filter",
          `name=^${name}$`,
          "--filter",
          label,
          "--format",
          "{{.Name}}",
        ]),
      ],
      { concurrency: "unbounded" },
    );
    const [container, state] = row.split(" ");
    return { container: container || null, state, volume: volumeName === name };
  });

  const getContainer = Effect.fn("HostedWorkspace.getContainer")(function* (
    id: HostedWorkspaceId,
    operation: string,
  ) {
    const resource = yield* lookup(id);
    if (!resource.container || !resource.volume) {
      return yield* new HostedWorkspaceError({
        workspaceId: id,
        operation,
        cause: "Incomplete workspace",
      });
    }
    return resource.container;
  });

  const remove = Effect.fn("HostedWorkspace.remove")(function* (id: HostedWorkspaceId) {
    const resource = yield* lookup(id);
    if (resource.container) {
      yield* checkedDocker(id, "remove container from", [
        "container",
        "rm",
        "--force",
        resource.container,
      ]);
    }
    if (resource.volume) {
      yield* checkedDocker(id, "remove volume from", ["volume", "rm", resourceName(id)]);
    }
  });

  const create = Effect.fn("HostedWorkspace.create")(function* (input: {
    readonly repository: string;
    readonly image: string;
    readonly branch?: string;
  }) {
    const id = HostedWorkspaceId.make(yield* random.uuidV4());
    const name = resourceName(id);
    const label = `${WORKSPACE_LABEL}=${id}`;
    const repository = yield* decodeRepository(input.repository).pipe(
      Effect.mapError(
        (cause) => new HostedWorkspaceError({ workspaceId: id, operation: "validate", cause }),
      ),
    );
    return yield* Effect.gen(function* () {
      yield* checkedDocker(id, "create volume for", [
        "volume",
        "create",
        "--label",
        label,
        "--",
        name,
      ]);
      const container = yield* checkedDocker(
        id,
        "create container for",
        [
          "container",
          "create",
          "--name",
          name,
          "--label",
          label,
          "--mount",
          `type=volume,source=${name},target=${WORKSPACE_HOME}`,
          "--user",
          "1000:1000",
          "--init",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--cpus",
          "2",
          "--memory",
          "4g",
          "--env",
          `HOME=${WORKSPACE_HOME}`,
          "--entrypoint",
          "/usr/bin/sleep",
          "--",
          input.image,
          "infinity",
        ],
        "15 minutes",
      );
      yield* checkedDocker(id, "start", ["container", "start", container]);
      yield* checkedDocker(
        id,
        "clone repository into",
        [
          "container",
          "exec",
          "--env",
          "GIT_TERMINAL_PROMPT=0",
          container,
          "git",
          "clone",
          ...(input.branch === undefined ? [] : [`--branch=${input.branch}`]),
          "--",
          `https://github.com/${repository}.git`,
          REPOSITORY_PATH,
        ],
        "15 minutes",
      );
      return id;
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Success" ? Effect.void : remove(id).pipe(Effect.ignoreCause({ log: true })),
      ),
    );
  });

  const workspaces = {
    create,
    status: Effect.fn("HostedWorkspace.status")(function* (id) {
      const { container, state, volume } = yield* lookup(id);
      if (container && volume) return state === "running" ? "running" : "stopped";
      return container || volume ? "partial" : "absent";
    }),
    start: Effect.fn("HostedWorkspace.start")(function* (id) {
      const container = yield* getContainer(id, "start");
      yield* checkedDocker(id, "start", ["container", "start", container]);
    }),
    stop: Effect.fn("HostedWorkspace.stop")(function* (id) {
      const container = yield* getContainer(id, "stop");
      yield* checkedDocker(id, "stop", ["container", "stop", "--time", "5", container]);
    }),
    remove,
    run: Effect.fn("HostedWorkspace.run")(function* (id, argv) {
      const container = yield* getContainer(id, "run a command in");
      return yield* docker(
        id,
        "run a command in",
        ["container", "exec", "--workdir", REPOSITORY_PATH, container, ...argv],
        "15 minutes",
      );
    }),
  } satisfies Omit<HostedWorkspace["Service"], "act">;

  const act = Effect.fn("HostedWorkspace.act")(
    function* (
      input: HostedWorkspaceAction,
    ): Effect.fn.Return<HostedWorkspaceResult, HostedWorkspaceRpcError | HostedWorkspaceError> {
      if (configuredImage === null)
        return yield* new HostedWorkspaceRpcError({ status: "unavailable" });
      switch (input._tag) {
        case "create": {
          const id = yield* workspaces.create({
            repository: input.repository,
            image: configuredImage,
            ...(input.branch === undefined ? {} : { branch: input.branch }),
          });
          return { _tag: "workspace", id, state: "running" };
        }
        case "manage": {
          if (input.operation !== "status") yield* workspaces[input.operation](input.id);
          const state = yield* workspaces.status(input.id);
          return { _tag: "workspace", id: input.id, state };
        }
        case "run": {
          const command = yield* workspaces.run(input.id, input.argv);
          return { _tag: "command", ...command };
        }
      }
    },
    Effect.catchTags({
      HostedWorkspaceError: (error) =>
        Effect.fail(new HostedWorkspaceRpcError({ status: "failed", id: error.workspaceId })),
    }),
  );

  return HostedWorkspace.of({ ...workspaces, act });
});

export const layer = Layer.effect(HostedWorkspace, make);
