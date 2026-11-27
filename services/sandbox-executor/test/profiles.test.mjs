import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionRegistry,
  buildContainerConfig,
  buildVerificationContainerConfig,
  normalizeTimeoutMs,
  validateProfileRequest,
} from "../profiles.mjs";

const roots = {
  workspaceRoot: "/srv/perskop/workspaces",
  credentialRoot: "/srv/perskop/credentials",
  providerRuntimeRoot: "/srv/perskop/provider-runtimes",
  sandboxNetwork: "perskop_sandbox_internal",
  proxyUrl: "http://provider-egress-proxy:18888",
};

test("rejects unknown profiles and providers", () => {
  assert.throws(
    () => validateProfileRequest({ profile: "shell", provider: "codex" }),
    /Unknown execution profile/,
  );
  assert.throws(
    () => validateProfileRequest({ profile: "chat", provider: "arbitrary" }),
    /Unknown provider/,
  );
});

test("chat has no repository bind and coding has only its approved workspace", () => {
  const chat = buildContainerConfig(
    {
      taskId: "chat-1",
      cmd: ["codex", "hello"],
      profile: "chat",
      provider: "codex",
    },
    roots,
  );
  assert.equal(chat.WorkingDir, "/tmp/work");
  assert.equal(
    chat.HostConfig.Binds.some((bind) => bind.includes("workspaces")),
    false,
  );

  const coding = buildContainerConfig(
    {
      taskId: "code-1",
      cmd: ["codex", "fix tests"],
      profile: "coding",
      provider: "codex",
      workspaceSubdir: "task_code-1",
      operation: { workingDirectory: "packages/gateway" },
    },
    roots,
  );
  assert.equal(coding.WorkingDir, "/workspace/packages/gateway");
  assert.deepEqual(
    coding.HostConfig.Binds.filter((bind) => bind.endsWith(":/workspace:rw")),
    ["/srv/perskop/workspaces/task_code-1:/workspace:rw"],
  );
});

test("request payload cannot inject host binds or escape workspace root", () => {
  assert.throws(
    () =>
      buildContainerConfig(
        {
          taskId: "code-2",
          cmd: ["codex"],
          profile: "coding",
          provider: "codex",
          workspaceSubdir: "../../etc",
          binds: ["/:/host:rw"],
        },
        roots,
      ),
    /Invalid workspaceSubdir/,
  );
});

test("mounts exactly one selected provider credential directory", () => {
  const expectedSources = {
    codex: "codex",
    cursor: "cursor",
    opencode: "config/opencode",
    antigravity: "gemini",
  };
  for (const provider of ["codex", "cursor", "opencode", "antigravity"]) {
    const config = buildContainerConfig(
      {
        taskId: provider,
        cmd: [provider],
        profile: "chat",
        provider,
      },
      roots,
    );
    const credentialBinds = config.HostConfig.Binds.filter((bind) =>
      bind.startsWith(roots.credentialRoot),
    );
    assert.equal(credentialBinds.length, 2);
    assert.ok(
      credentialBinds.some((bind) =>
        bind.startsWith(
          `${roots.credentialRoot}/${expectedSources[provider]}:`,
        ),
      ),
    );
    assert.equal(
      credentialBinds.some(
        (bind) =>
          !bind.startsWith(
            `${roots.credentialRoot}/${expectedSources[provider]}:`,
          ) && !bind.startsWith(`${roots.credentialRoot}/bin/`),
      ),
      false,
    );
  }
});

test("mounts only the selected provider runtime dependency", () => {
  const codex = buildContainerConfig(
    {
      taskId: "codex-runtime",
      cmd: ["codex"],
      profile: "chat",
      provider: "codex",
    },
    roots,
  );
  assert.deepEqual(
    codex.HostConfig.Binds.filter((bind) =>
      bind.startsWith(roots.providerRuntimeRoot),
    ),
    [
      "/srv/perskop/provider-runtimes/@openai/codex:/home/node/.local/lib/node_modules/@openai/codex:ro",
    ],
  );

  const cursor = buildContainerConfig(
    {
      taskId: "cursor-runtime",
      cmd: ["cursor-agent"],
      profile: "chat",
      provider: "cursor",
    },
    roots,
  );
  assert.equal(
    cursor.HostConfig.Binds.some((bind) =>
      bind.startsWith(roots.providerRuntimeRoot),
    ),
    false,
  );
});

test("forces proxy egress and a narrow internal NO_PROXY", () => {
  const config = buildContainerConfig(
    {
      taskId: "chat-2",
      cmd: ["opencode", "hello"],
      profile: "chat",
      provider: "opencode",
      env: {
        HTTPS_PROXY: "http://attacker.invalid",
        NO_PROXY: "*",
        OPENAI_API_KEY: "not-forwarded",
        LANG: "tr_TR.UTF-8",
      },
    },
    roots,
  );
  const env = Object.fromEntries(
    config.Env.map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
  assert.equal(env.HTTPS_PROXY, roots.proxyUrl);
  assert.equal(env.HTTP_PROXY, roots.proxyUrl);
  assert.equal(
    env.NO_PROXY,
    "perskop-gateway,sandbox-executor,provider-egress-proxy,localhost,127.0.0.1",
  );
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.LANG, "tr_TR.UTF-8");
});

test("clamps timeouts and cancellation removes the active container", () => {
  assert.equal(normalizeTimeoutMs(undefined), 300_000);
  assert.equal(normalizeTimeoutMs(1), 1_000);
  assert.equal(normalizeTimeoutMs(9_999_999), 900_000);
  assert.throws(() => normalizeTimeoutMs("forever"), /Invalid timeoutMs/);

  const registry = new ExecutionRegistry();
  registry.start("task-1", "container-1");
  assert.equal(registry.cancel("task-1"), "container-1");
  assert.equal(registry.get("task-1"), undefined);
  assert.equal(registry.wasCancelled("task-1"), true);
  registry.finish("task-1");
  assert.equal(registry.wasCancelled("task-1"), false);
});

test("verification runs without credentials or network access", () => {
  const config = buildVerificationContainerConfig(
    {
      taskId: "verify-1",
      cmd: ["codex", "change"],
      profile: "coding",
      provider: "codex",
      workspaceSubdir: "task_verify-1",
      operation: {
        workingDirectory: "workspace",
        verificationCommand: ["node", "--test"],
      },
    },
    roots,
  );
  assert.deepEqual(config.Cmd, ["node", "--test"]);
  assert.equal(config.HostConfig.NetworkMode, "none");
  assert.deepEqual(config.HostConfig.Binds, [
    "/srv/perskop/workspaces/task_verify-1:/workspace:rw",
  ]);
  assert.equal(
    config.HostConfig.Binds.some((bind) => bind.includes("credentials")),
    false,
  );
});
