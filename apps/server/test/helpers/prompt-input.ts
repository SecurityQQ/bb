import type { RuntimePromptInput } from "@bb/domain";

function textPrompt(
  text: string,
): Extract<RuntimePromptInput, { type: "text" }> {
  return { type: "text", text, mentions: [] };
}

export function textInput(
  text: string,
): Extract<RuntimePromptInput, { type: "text" }>[] {
  return [textPrompt(text)];
}

export function skillInput(
  name: string,
  rest = "",
): Extract<RuntimePromptInput, { type: "text" }>[] {
  const command = `/${name}`;
  return [
    {
      type: "text",
      text: `${command}${rest}`,
      mentions: [
        {
          start: 0,
          end: command.length,
          resource: {
            kind: "command",
            trigger: "/",
            name,
            source: "skill",
            origin: "user",
            label: name,
            argumentHint: null,
          },
        },
      ],
    },
  ];
}
