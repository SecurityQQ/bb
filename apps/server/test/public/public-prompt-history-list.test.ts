import { eq } from "drizzle-orm";
import {
  createPromptHistoryEntry,
  listQueuedThreadMessages,
  getProjectAttachment,
  projects,
} from "@bb/db";
import {
  referencePromptHistoryListResponseSchema,
  promptHistoryListResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import {
  readAttachment,
  storeAttachment,
} from "../../src/services/projects/attachments.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedHostSession,
  seedEnvironment,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public prompt history list route", () => {
  it.each([
    ["localImage", false],
    ["localFile", false],
    ["localImage", true],
    ["localFile", true],
  ] as const)(
    "restores history %s attachments with reference representation %s into another project's queued prompt",
    async (type, references) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project: source } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const { project: destination } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const sourceThread = seedThread(harness.deps, { projectId: source.id });
        const destinationThread = seedThread(harness.deps, {
          projectId: destination.id,
        });
        const attachment = await storeAttachment(
          harness.deps.db,
          harness.deps.config.dataDir,
          source.id,
          new File(
            ["attachment bytes"],
            type === "localImage" ? "attachment.png" : "attachment.txt",
            {
              type: type === "localImage" ? "image/png" : "text/plain",
            },
          ),
        );
        createPromptHistoryEntry(harness.deps.db, {
          projectId: source.id,
          threadId: sourceThread.id,
          scope: "thread",
          requestSequence: 1,
          input: [
            ...textInput("Review this attachment"),
            { type, path: attachment.path, visibility: "agent-only" },
          ],
        });

        const history = promptHistoryListResponseSchema.parse(
          await readJson(await harness.app.request("/api/v1/prompt-history")),
        );
        expect(history.entries[0]!.input[1]).toMatchObject({
          type,
          path: attachment.path,
        });
        const referenceHistory = referencePromptHistoryListResponseSchema.parse(
          await readJson(
            await harness.app.request("/api/v1/prompt-history", {
              headers: { "x-bb-prompt-references": "1" },
            }),
          ),
        );
        expect(referenceHistory.entries[0]!.input[1]).toEqual({
          type: "attachment",
          attachmentId: attachment.id,
          visibility: "agent-only",
        });
        const input = references
          ? referenceHistory.entries[0]!.input
          : history.entries[0]!.input;
        const response = await harness.app.request(
          `/api/v1/threads/${destinationThread.id}/queued-messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input,
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
            }),
          },
        );

        expect(response.status, JSON.stringify(await readJson(response))).toBe(
          201,
        );
        expect(
          (
            await readAttachment(
              harness.deps.config.dataDir,
              destination.id,
              attachment.path,
            )
          ).content.toString(),
        ).toBe("attachment bytes");
        const queued = listQueuedThreadMessages(
          harness.deps.db,
          destinationThread.id,
        )[0]!;
        const destinationAttachment = getProjectAttachment(
          harness.deps.db,
          destination.id,
          attachment.path,
        )!;
        expect(destinationAttachment.id).not.toBe(attachment.id);
        expect(JSON.parse(queued.content)).toMatchObject([
          ...textInput("Review this attachment"),
          {
            type,
            path: attachment.path,
            attachmentId: destinationAttachment.id,
          },
        ]);
        const edited = await harness.app.request(
          `/api/v1/threads/${destinationThread.id}/queued-messages/${queued.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input,
              expectedUpdatedAt: queued.updatedAt,
            }),
          },
        );
        expect(edited.status).toBe(200);
        expect(
          listQueuedThreadMessages(harness.deps.db, destinationThread.id)[0]!
            .content,
        ).toBe(queued.content);
        harness.deps.db
          .delete(projects)
          .where(eq(projects.id, source.id))
          .run();
        const content = await harness.app.request(
          `/api/v1/attachments/${destinationAttachment.id}/content`,
        );
        expect(content.status).toBe(200);
        expect(await content.text()).toBe("attachment bytes");
        expect(
          (await harness.app.request(`/api/v1/attachments/${attachment.id}`))
            .status,
        ).toBe(400);
      });
    },
  );

  it("binds legacy host paths and rejects explicit cross-host paths before accepting a queued message", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        projectId: project.id,
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const queue = (input: object[]) =>
        harness.app.request(`/api/v1/threads/${thread.id}/queued-messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input,
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
          }),
        });
      const rejected = await queue([
        { type: "localFile", path: "/tmp/report.txt", hostId: "another-host" },
      ]);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("destination host");
      expect(listQueuedThreadMessages(harness.deps.db, thread.id)).toHaveLength(
        0,
      );
      expect(
        (await queue([{ type: "localFile", path: "/tmp/report.txt" }])).status,
      ).toBe(201);
      expect(
        JSON.parse(
          listQueuedThreadMessages(harness.deps.db, thread.id)[0]!.content,
        ),
      ).toEqual([
        { type: "localFile", path: "/tmp/report.txt", hostId: host.id },
      ]);
      const invalid = await queue([
        { type: "attachment", attachmentId: "missing" },
      ]);
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("unavailable");
      expect(listQueuedThreadMessages(harness.deps.db, thread.id)).toHaveLength(
        1,
      );
    });
  });

  it("marks old hostless file history unavailable without guessing the current host", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, { projectId: project.id });
      createPromptHistoryEntry(harness.deps.db, {
        projectId: project.id,
        threadId: thread.id,
        scope: "thread",
        requestSequence: 1,
        input: [{ type: "localFile", path: "/tmp/report.txt" }],
      });
      const response = await harness.app.request("/api/v1/prompt-history", {
        headers: { "x-bb-prompt-references": "1" },
      });
      const history = referencePromptHistoryListResponseSchema.parse(
        await readJson(response),
      );
      expect(history.entries[0]!.input).toEqual([
        {
          type: "unavailableAttachment",
          path: "/tmp/report.txt",
          reason: expect.stringContaining("original host"),
        },
      ]);
      const legacy = promptHistoryListResponseSchema.parse(
        await readJson(await harness.app.request("/api/v1/prompt-history")),
      );
      expect(legacy.entries[0]!.input).toEqual([
        { type: "localFile", path: "/tmp/report.txt" },
      ]);
    });
  });

  it("pages every prompt newest first with project and thread locations", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const first = seedThread(harness.deps, { projectId: project.id });
      const second = seedThread(harness.deps, { projectId: project.id });
      const seed = (
        threadId: string,
        requestSequence: number,
        text: string,
        createdAt: number,
      ) =>
        createPromptHistoryEntry(harness.deps.db, {
          projectId: project.id,
          threadId,
          scope: "thread",
          requestSequence,
          input: textInput(text),
          createdAt,
        });
      const oldest = seed(first.id, 1, "Investigate auth flow", 10);
      const older = seed(first.id, 2, "Fix the login test", 20);
      const newer = seed(second.id, 1, "Write release notes", 30);
      const newest = seed(second.id, 2, "Review release notes", 40);
      const page = async (query: string) =>
        promptHistoryListResponseSchema.parse(
          await readJson(
            await harness.app.request(`/api/v1/prompt-history?${query}`),
          ),
        );

      const firstPage = await page("limit=2");
      expect(firstPage.entries).toEqual([
        {
          id: newest.id,
          createdAt: 40,
          input: textInput("Review release notes"),
          projectId: project.id,
          threadId: second.id,
        },
        {
          id: newer.id,
          createdAt: 30,
          input: textInput("Write release notes"),
          projectId: project.id,
          threadId: second.id,
        },
      ]);
      if (firstPage.nextCursor === null) throw new Error("expected a cursor");

      const secondPage = await page(`limit=2&cursor=${firstPage.nextCursor}`);
      expect(secondPage.entries.map((entry) => entry.id)).toEqual([
        older.id,
        oldest.id,
      ]);
      expect(secondPage.nextCursor).toBeNull();
    });
  });

  it("rejects a malformed cursor or limit", async () => {
    await withTestHarness(async (harness) => {
      for (const url of [
        "/api/v1/prompt-history?cursor=not-a-cursor",
        "/api/v1/prompt-history?limit=bad",
        "/api/v1/prompt-history?limit=0",
      ]) {
        const response = await harness.app.request(url);
        expect(response.status, url).toBe(400);
      }
    });
  });
});
