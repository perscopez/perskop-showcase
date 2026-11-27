import type { AppConfig } from "../config.js";
import {
  buildAgentPrompt,
  prepareAgentWorkspace,
  type MailPromptContext,
} from "../capabilities/workspace.js";

export type { MailPromptContext };

/** Prepare /data workspace then return a short agent prompt. */
export async function augmentPromptWithMail(
  config: AppConfig,
  userPrompt: string,
  ctx: MailPromptContext = {},
): Promise<string> {
  await prepareAgentWorkspace(config, userPrompt, ctx);
  return buildAgentPrompt(config, userPrompt);
}
