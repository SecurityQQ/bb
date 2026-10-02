import type {
  PromptInput,
  RuntimePromptInput,
  ReferencePromptHistoryEntry,
} from "@bb/domain";
import type { AppCreateThreadRequest } from "@bb/client-core";
import { sdk } from "./sdk";

async function resolveReferences(
  input: readonly (RuntimePromptInput | PromptInput)[],
  context: () => Promise<{ projectId: string; hostId: string | null }>,
): Promise<PromptInput[]> {
  let resolvedContext: ReturnType<typeof context> | undefined;
  return Promise.all(
    input.map(async (entry): Promise<PromptInput> => {
      if (entry.type !== "localImage" && entry.type !== "localFile")
        return entry;
      const item: RuntimePromptInput = entry;
      const visibility = item.visibility ? { visibility: item.visibility } : {};
      if (item.unavailableReason) throw new Error(item.unavailableReason);
      if (item.attachmentId)
        return {
          type: "attachment",
          attachmentId: item.attachmentId,
          ...visibility,
        };
      if (item.hostId)
        return {
          type: item.type,
          hostId: item.hostId,
          path: item.path,
          ...visibility,
        };
      resolvedContext ??= context();
      const target = await resolvedContext;
      if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(item.path)) {
        if (!target.hostId)
          throw new Error(
            "This file needs an explicit host. Upload it before sending.",
          );
        return {
          type: item.type,
          hostId: target.hostId,
          path: item.path,
          ...visibility,
        };
      }
      const attachment = await sdk.projects.attachments.experimental_lookup({
        projectId: item.experimental_sourceProjectId ?? target.projectId,
        path: item.path,
      });
      return { type: "attachment", attachmentId: attachment.id, ...visibility };
    }),
  );
}

export function threadPromptReferences(
  input: readonly (RuntimePromptInput | PromptInput)[],
  threadId: string,
): Promise<PromptInput[]> {
  return resolveReferences(input, async () => {
    const thread = await sdk.threads.get({ threadId, include: "environment" });
    return {
      projectId: thread.projectId,
      hostId:
        "environment" in thread ? (thread.environment?.hostId ?? null) : null,
    };
  });
}

export function createPromptReferences(
  request: Pick<AppCreateThreadRequest, "input" | "projectId" | "environment">,
): Promise<PromptInput[]> {
  return resolveReferences(request.input, async () => {
    const environment = request.environment;
    const hostId =
      environment.type === "reuse"
        ? (
            await sdk.environments.get({
              environmentId: environment.environmentId,
            })
          ).hostId
        : environment.type === "host"
          ? (environment.hostId ?? null)
          : environment.type === "provider" &&
              environment.machine?.type === "existing"
            ? environment.machine.hostId
            : null;
    return { projectId: request.projectId, hostId };
  });
}

export async function hydratePromptHistory<
  T extends ReferencePromptHistoryEntry,
>(
  entries: readonly T[],
): Promise<(Omit<T, "input"> & { input: RuntimePromptInput[] })[]> {
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      input: await Promise.all(
        entry.input.map(async (item): Promise<RuntimePromptInput> => {
          if (item.type === "unavailableAttachment")
            return {
              type: "localFile",
              path: item.path,
              unavailableReason: item.reason,
            };
          if (item.type !== "attachment") return item;
          const attachment = await sdk.projects.attachments.experimental_get({
            attachmentId: item.attachmentId,
          });
          return {
            type: attachment.type,
            path: attachment.path,
            attachmentId: attachment.id,
            ...(item.visibility ? { visibility: item.visibility } : {}),
            experimental_sourceProjectId:
              attachment.experimental_sourceProjectId,
            name: attachment.name,
            sizeBytes: attachment.sizeBytes,
            mimeType: attachment.mimeType,
          };
        }),
      ),
    })),
  );
}
