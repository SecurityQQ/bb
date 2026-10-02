import type {
  EnvironmentActionRequest,
  RuntimeEditMessageRequest,
  RuntimeSendMessageRequest,
} from "@bb/server-contract";

export type RequestEnvironmentActionMutationRequest = {
  id: string;
} & EnvironmentActionRequest;

export interface SendThreadMessageMutationRequest extends RuntimeSendMessageRequest {
  id: string;
}

export interface EditMessageMutationRequest extends RuntimeEditMessageRequest {
  id: string;
}
