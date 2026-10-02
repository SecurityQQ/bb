import { referenceHistoryInput } from "../services/projects/attachments.js";
import type { Hono } from "hono";
import type { PromptHistoryPosition } from "@bb/db";
import {
  PROMPT_HISTORY_PAGE_DEFAULT_LIMIT,
  PROMPT_HISTORY_PAGE_MAX_LIMIT,
} from "@bb/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import { parseBoundedPositiveOptionalInteger } from "../services/lib/validation.js";
import {
  decodePromptHistoryCursor,
  listPromptHistory,
} from "../services/prompt-history.js";
import type { AppDeps } from "../types.js";

export function registerPromptHistoryRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get(publicApiRoutes.promptHistory.list, async (context, query) => {
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_PAGE_DEFAULT_LIMIT,
      max: PROMPT_HISTORY_PAGE_MAX_LIMIT,
      name: "limit",
      value: query.limit,
    });
    let before: PromptHistoryPosition | null = null;
    if (query.cursor !== undefined) {
      before = decodePromptHistoryCursor(query.cursor);
      if (before === null) {
        throw new ApiError(
          400,
          "invalid_request",
          "Invalid prompt history cursor",
        );
      }
    }
    const result = listPromptHistory(deps, { before, limit });
    if (context.req.header("x-bb-prompt-references") === "1") {
      const entries = await Promise.all(
        result.entries.map(async (entry) => ({
          ...entry,
          input: await referenceHistoryInput(
            deps.db,
            deps.config.dataDir,
            entry.projectId,
            entry.input,
          ),
        })),
      );
      return new Response(JSON.stringify({ ...result, entries }), {
        headers: {
          "content-type": "application/json",
          vary: "x-bb-prompt-references",
        },
      });
    }
    return context.json(result);
  });
}
