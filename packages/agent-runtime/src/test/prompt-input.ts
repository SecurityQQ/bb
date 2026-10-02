import type { RuntimePromptInput } from "@bb/domain";

interface PromptTextInputArgs {
  text: string;
}

export function promptTextInput(args: PromptTextInputArgs): RuntimePromptInput {
  return { type: "text", text: args.text, mentions: [] };
}
