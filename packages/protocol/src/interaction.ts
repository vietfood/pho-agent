import type { AskUserAnswer, AskUserQuestion } from "./plan-agent";

export interface AgentInteractionOption {
  value: string;
  label: string;
  description?: string;
}

export type AgentInteractionRequest =
  | {
      requestId: string;
      kind: "approval";
      title: string;
      message?: string;
      options: AgentInteractionOption[];
    }
  | {
      requestId: string;
      kind: "questionnaire";
      title: string;
      questions: AskUserQuestion[];
    };

export interface AgentInteractionResolution {
  requestId: string;
  cancelled?: boolean;
  selected?: string;
  answers?: AskUserAnswer[];
}
