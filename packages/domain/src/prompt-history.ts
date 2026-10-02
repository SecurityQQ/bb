import { z } from "zod";
import {
  runtimePromptInputSchema,
  promptInputSchema,
  type RuntimePromptInput,
} from "./shared-types.js";

export const PROMPT_HISTORY_ENTRY_LIMIT = 50;
export const PROMPT_HISTORY_PAGE_DEFAULT_LIMIT = 100;
export const PROMPT_HISTORY_PAGE_MAX_LIMIT = 1000;

const promptHistoryScopeValues = ["project", "thread"] as const;
const promptHistoryScopeSchema = z.enum(promptHistoryScopeValues);
export type PromptHistoryScope = z.infer<typeof promptHistoryScopeSchema>;

export const promptHistoryEntrySchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  input: z.array(runtimePromptInputSchema).min(1),
});
export type PromptHistoryEntry = z.infer<typeof promptHistoryEntrySchema>;

export const promptHistoryListEntrySchema = promptHistoryEntrySchema.extend({
  projectId: z.string().min(1),
  threadId: z.string().min(1),
});
export type PromptHistoryListEntry = z.infer<
  typeof promptHistoryListEntrySchema
>;

interface PromptHistoryComparableEntry {
  input: readonly RuntimePromptInput[];
}

interface TakeVisiblePromptHistoryEntriesArgs<
  TEntry extends PromptHistoryComparableEntry,
> {
  entries: readonly TEntry[];
  limit: number;
}

export function arePromptHistoryInputsEqual(
  left: readonly RuntimePromptInput[],
  right: readonly RuntimePromptInput[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function takeVisiblePromptHistoryEntries<
  TEntry extends PromptHistoryComparableEntry,
>({ entries, limit }: TakeVisiblePromptHistoryEntriesArgs<TEntry>): TEntry[] {
  if (limit <= 0 || entries.length === 0) {
    return [];
  }

  const visibleEntries: TEntry[] = [];
  for (const entry of entries) {
    const lastVisibleEntry = visibleEntries[visibleEntries.length - 1];
    if (
      lastVisibleEntry &&
      arePromptHistoryInputsEqual(lastVisibleEntry.input, entry.input)
    ) {
      continue;
    }

    visibleEntries.push(entry);
    if (visibleEntries.length >= limit) {
      break;
    }
  }

  return visibleEntries;
}

export const referencePromptHistoryInputSchema = z.union([
  promptInputSchema,
  z.object({
    type: z.literal("unavailableAttachment"),
    path: z.string(),
    reason: z.string(),
  }),
]);
export const referencePromptHistoryEntrySchema =
  promptHistoryEntrySchema.extend({
    input: z.array(referencePromptHistoryInputSchema),
  });
export type ReferencePromptHistoryEntry = z.infer<
  typeof referencePromptHistoryEntrySchema
>;
export const referencePromptHistoryListEntrySchema =
  referencePromptHistoryEntrySchema.extend({
    projectId: z.string(),
    threadId: z.string(),
  });
export type ReferencePromptHistoryListEntry = z.infer<
  typeof referencePromptHistoryListEntrySchema
>;
