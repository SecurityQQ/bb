import { referencePromptHistoryListResponseSchema } from "@bb/server-contract";
import type {
  PromptHistoryListQuery,
  ReferencePromptHistoryListResponse,
} from "@bb/server-contract";
import { type CreateSdkAreaArgs } from "./common.js";

export type ExperimentalPromptHistoryListArgs = PromptHistoryListQuery & {
  signal?: AbortSignal;
};

export type ExperimentalPromptHistoryListResult =
  ReferencePromptHistoryListResponse;

export interface ExperimentalPromptHistoryArea {
  list(
    args?: ExperimentalPromptHistoryListArgs,
  ): Promise<ExperimentalPromptHistoryListResult>;
}

export function createPromptHistoryArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalPromptHistoryArea {
  return {
    async list(input = {}) {
      const { signal, ...query } = input;
      return transport
        .readJson(
          transport.api.v1["prompt-history"].$get(
            { query },
            { headers: { "x-bb-prompt-references": "1" }, init: { signal } },
          ),
        )
        .then((result) =>
          referencePromptHistoryListResponseSchema.parse(result),
        );
    },
  };
}
