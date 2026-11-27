import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../../src/db.js";
import { NodeService } from "../../src/tasks/nodeService.js";
import { TaskService } from "../../src/tasks/taskService.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perskop-nodes-"));
  const memory = new MemoryStore(dir);
  return { dir, memory, nodes: new NodeService(memory), tasks: new TaskService(memory) };
}

function cleanup(dir: string, memory: MemoryStore) {
  memory.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test("nodes, agent_sessions and append-only task_events survive restart", () => {
  const { dir, memory, nodes } = fixture();
  const registered = nodes.register({
    nodeId: "mac",
    displayName: "MacBook",
    appVersion: "0.17.0",
    capabilities: ["session_control", "repository_write"],
  });
  assert.equal(registered.nodeId, "mac");
  assert.ok(registered.token.length >= 32);
  assert.equal(registered.tokenHash.length, 64);

  nodes.heartbeat({
    nodeId: "mac",
    token: registered.token,
    capabilities: ["session_control"],
    currentLoad: 1,
    sessions: [{
      sessionId: "sess-1",
      source: "hermes",
      provider: "cursor",
      status: "active",
      title: "Perskop Developing",
    }],
  });

  const taskId = memory.addTask({
    source: "mac",
    prompt: "Wait for Mac",
    status: "waiting_for_node",
  });
  nodes.assignTask({ taskId, targetNodeId: "mac", parentSessionId: "sess-1" });
  nodes.appendTaskEvent({
    taskId,
    nodeId: "mac",
    eventType: "queued",
    revision: 1,
    payload: { reason: "offline" },
  });

  memory.db.close();
  const restarted = new MemoryStore(dir);
  const restartedNodes = new NodeService(restarted);
  const node = restartedNodes.getNode("mac");
  assert.equal(node?.display_name, "MacBook");
  assert.equal(node?.app_version, "0.17.0");
  assert.deepEqual(JSON.parse(String(node?.capabilities_json)), ["session_control"]);
  assert.equal(node?.current_load, 1);
  assert.equal(node?.revoked_at, null);

  const sessions = restartedNodes.listSessions("mac");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, "sess-1");
  assert.equal(sessions[0].title, "Perskop Developing");
  assert.equal(sessions[0].revision, 1);

  const task = restarted.db.prepare("SELECT target_node_id,parent_session_id FROM tasks WHERE id=?").get(taskId) as any;
  assert.equal(task.target_node_id, "mac");
  assert.equal(task.parent_session_id, "sess-1");

  const events = restartedNodes.listTaskEvents(taskId);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "queued");
  assert.equal(events[0].revision, 1);

  assert.throws(() => {
    restarted.db.prepare("UPDATE task_events SET event_type='mutated' WHERE task_id=?").run(taskId);
  });
  assert.equal(restartedNodes.listTaskEvents(taskId)[0].event_type, "queued");

  cleanup(dir, restarted);
});

test("revoked node tokens cannot heartbeat or claim tasks", () => {
  const { dir, memory, nodes, tasks } = fixture();
  const registered = nodes.register({
    nodeId: "mac",
    displayName: "MacBook",
    capabilities: ["session_control"],
  });
  nodes.revoke("mac");
  assert.throws(() => nodes.heartbeat({
    nodeId: "mac",
    token: registered.token,
    capabilities: ["session_control"],
    currentLoad: 0,
    sessions: [],
  }), /node_revoked|node_unauthorized/);

  const taskId = memory.addTask({ source: "telegram", prompt: "claim me", status: "pending" });
  tasks.transition(taskId, { to: "waiting_for_node", expectedRevision: 1 });
  nodes.assignTask({ taskId, targetNodeId: "mac" });
  const claim = nodes.claimTask({ nodeId: "mac", token: registered.token, taskId, expectedRevision: 2 });
  assert.equal(claim.ok, false);
  cleanup(dir, memory);
});
