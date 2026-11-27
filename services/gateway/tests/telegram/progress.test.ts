import test from "node:test";
import assert from "node:assert/strict";
import { withTelegramProgress } from "../../src/telegram/progress.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Telegram progress keeps typing alive, posts one delayed notice, and stops after completion", async () => {
  const actions: string[] = [];
  const replies: string[] = [];
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  const resultPromise = withTelegramProgress({
    replyWithChatAction: async (action) => { actions.push(action); },
    reply: async (text) => { replies.push(text); },
  }, () => pending, { typingIntervalMs: 5, noticeDelayMs: 8 });
  await sleep(18);
  finish("ok");
  assert.equal(await resultPromise, "ok");
  assert.ok(actions.length >= 2);
  assert.deepEqual(replies, ["Üzerinde çalışıyorum; hazır olunca sonucu buraya yazacağım."]);
  const stoppedAt = actions.length;
  await sleep(12);
  assert.equal(actions.length, stoppedAt);
});

test("Telegram progress clears timers when the task fails", async () => {
  let actions = 0;
  await assert.rejects(withTelegramProgress({
    replyWithChatAction: async () => { actions += 1; },
    reply: async () => undefined,
  }, async () => { throw new Error("failed"); }, { typingIntervalMs: 5, noticeDelayMs: 5 }), /failed/);
  const stoppedAt = actions;
  await sleep(12);
  assert.equal(actions, stoppedAt);
});
