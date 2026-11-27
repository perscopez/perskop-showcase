import path from "node:path";

const PROFILE_NAMES = new Set(["chat", "coding"]);
const PROVIDERS = Object.freeze({
  codex: {
    binary: "codex",
    credentialSource: "codex",
    credentialTarget: "/home/node/.codex",
    runtimePackage: "@openai/codex",
    runtimeTarget: "/home/node/.local/lib/node_modules/@openai/codex",
  },
  cursor: {
    binary: "cursor-agent",
    credentialSource: "cursor",
    credentialTarget: "/home/node/.cursor",
  },
  opencode: {
    binary: "opencode",
    credentialSource: "config/opencode",
    credentialTarget: "/home/node/.config/opencode",
  },
  antigravity: {
    binary: "agy",
    credentialSource: "gemini",
    credentialTarget: "/home/node/.gemini",
  },
});

const SAFE_ENV_KEYS = new Set(["LANG", "LC_ALL", "TERM", "TZ"]);
const INTERNAL_NO_PROXY =
  "perskop-gateway,sandbox-executor,provider-egress-proxy,localhost,127.0.0.1";

function requiredString(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function validateProfileRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid execution payload");
  }
  const profile = requiredString(payload.profile, "profile");
  if (!PROFILE_NAMES.has(profile)) {
    throw new Error(`Unknown execution profile: ${profile}`);
  }
  const provider = requiredString(payload.provider, "provider");
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (
    !Array.isArray(payload.cmd) ||
    payload.cmd.length === 0 ||
    payload.cmd.some(
      (part) =>
        typeof part !== "string" || part.length === 0 || part.includes("\0"),
    )
  ) {
    throw new Error("Invalid cmd list");
  }
  requiredString(String(payload.taskId ?? ""), "taskId");
  if (profile === "coding") {
    requiredString(payload.workspaceSubdir, "workspaceSubdir");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(payload.workspaceSubdir)) {
      throw new Error("Invalid workspaceSubdir");
    }
  }
  if (
    payload.env !== undefined &&
    (!payload.env || typeof payload.env !== "object" || Array.isArray(payload.env))
  ) {
    throw new Error("Invalid env");
  }
  return { profile, provider };
}

export function normalizeTimeoutMs(value) {
  if (value === undefined) return 300_000;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Invalid timeoutMs");
  }
  return Math.max(1_000, Math.min(Math.trunc(value), 900_000));
}

function resolveWorkspace(root, subdir) {
  const absoluteRoot = path.resolve(root);
  const workspace = path.resolve(absoluteRoot, subdir);
  if (!workspace.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error("Workspace escapes staging root");
  }
  return workspace;
}

function buildEnvironment(inputEnv, proxyUrl) {
  const environment = {
    PATH:
      "/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/home/node",
  };
  for (const [key, value] of Object.entries(inputEnv ?? {})) {
    if (
      SAFE_ENV_KEYS.has(key) &&
      typeof value === "string" &&
      !value.includes("\0")
    ) {
      environment[key] = value;
    }
  }
  Object.assign(environment, {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: INTERNAL_NO_PROXY,
    no_proxy: INTERNAL_NO_PROXY,
  });
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}

export function buildContainerConfig(payload, roots) {
  const { profile, provider } = validateProfileRequest(payload);
  const providerConfig = PROVIDERS[provider];
  const credentialSource = path.join(
    roots.credentialRoot,
    providerConfig.credentialSource,
  );
  const binarySource = path.join(
    roots.credentialRoot,
    "bin",
    providerConfig.binary,
  );
  const binds = [
    `${binarySource}:/home/node/.local/bin/${providerConfig.binary}:ro`,
    `${credentialSource}:${providerConfig.credentialTarget}:rw`,
  ];
  if (providerConfig.runtimePackage) {
    binds.push(
      `${path.join(roots.providerRuntimeRoot, providerConfig.runtimePackage)}:${providerConfig.runtimeTarget}:ro`,
    );
  }

  let workingDir = "/tmp/work";
  if (profile === "coding") {
    const workspace = resolveWorkspace(
      roots.workspaceRoot,
      payload.workspaceSubdir,
    );
    binds.unshift(`${workspace}:/workspace:rw`);
    const requestedWorkingDirectory = payload.operation?.workingDirectory;
    if (
      requestedWorkingDirectory !== undefined &&
      (typeof requestedWorkingDirectory !== "string" ||
        requestedWorkingDirectory.startsWith("/") ||
        requestedWorkingDirectory.split("/").includes("..") ||
        /[\\*?\[\]{}]/.test(requestedWorkingDirectory))
    ) {
      throw new Error("Invalid operation workingDirectory");
    }
    workingDir =
      !requestedWorkingDirectory || requestedWorkingDirectory === "workspace"
        ? "/workspace"
        : `/workspace/${requestedWorkingDirectory}`;
  }

  return {
    Image: "perskop-coding-sandbox:v1",
    Cmd: [...payload.cmd],
    WorkingDir: workingDir,
    Env: buildEnvironment(payload.env, roots.proxyUrl),
    Labels: {
      "perskop.managed": "true",
      "perskop.taskId": String(payload.taskId),
      "perskop.profile": profile,
      "perskop.provider": provider,
    },
    HostConfig: {
      Binds: binds,
      Memory: profile === "chat" ? 268_435_456 : 536_870_912,
      NanoCpus: profile === "chat" ? 250_000_000 : 500_000_000,
      PidsLimit: profile === "chat" ? 64 : 100,
      NetworkMode: roots.sandboxNetwork,
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=64m",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [roots.sandboxNetwork]: {},
      },
    },
  };
}

export function buildVerificationContainerConfig(payload, roots) {
  const base = buildContainerConfig(payload, roots);
  const workspaceBind = base.HostConfig.Binds.find((bind) =>
    bind.endsWith(":/workspace:rw"),
  );
  if (!workspaceBind || !payload.operation) {
    throw new Error("Verification requires an approved repository workspace");
  }
  return {
    Image: base.Image,
    Cmd: [...payload.operation.verificationCommand],
    WorkingDir: base.WorkingDir,
    Env: [
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/tmp",
      "CI=1",
    ],
    Labels: {
      ...base.Labels,
      "perskop.profile": "verification",
    },
    HostConfig: {
      Binds: [workspaceBind],
      Memory: 536_870_912,
      NanoCpus: 500_000_000,
      PidsLimit: 100,
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: {
        "/tmp": "rw,noexec,nosuid,size=64m",
      },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
    },
  };
}

export function redactedExecutionSummary(payload) {
  return {
    taskId: String(payload.taskId),
    profile: payload.profile,
    provider: payload.provider,
    command: Array.isArray(payload.cmd) ? payload.cmd[0] : "invalid",
  };
}

export class ExecutionRegistry {
  #active = new Map();
  #cancelled = new Set();

  start(taskId, containerId) {
    this.#active.set(String(taskId), containerId);
  }

  get(taskId) {
    return this.#active.get(String(taskId));
  }

  cancel(taskId) {
    const key = String(taskId);
    const containerId = this.#active.get(key);
    if (containerId) {
      this.#active.delete(key);
      this.#cancelled.add(key);
    }
    return containerId;
  }

  wasCancelled(taskId) {
    return this.#cancelled.has(String(taskId));
  }

  finish(taskId) {
    const key = String(taskId);
    this.#active.delete(key);
    this.#cancelled.delete(key);
  }
}
