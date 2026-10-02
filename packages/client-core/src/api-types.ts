import type {
  ThreadOriginKind,
  PromptInput,
  RuntimePromptInput,
} from "@bb/domain";
import type { RuntimeCreateThreadRequest } from "@bb/server-contract";

export type AppCreateThreadRequest = Omit<
  RuntimeCreateThreadRequest,
  "origin" | "startedOnBehalfOf" | "originKind" | "input"
> &
  Partial<
    Pick<RuntimeCreateThreadRequest, "startedOnBehalfOf" | "originKind">
  > & { input: (PromptInput | RuntimePromptInput)[] };

export interface ThreadListFilters {
  projectId?: string;
  parentThreadId?: string;
  sourceThreadId?: string;
  sectionId?: string;
  unsectioned?: boolean;
  hasParent?: boolean;
  originKind?: ThreadOriginKind;
  archived: boolean;
  limit?: number;
  offset?: number;
}

export interface ThreadSearchFilters {
  query: string;
  limitPerGroup?: number;
}
