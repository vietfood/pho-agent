import { describe, expect, test } from "bun:test";
import { ApprovalController, type FrozenApprovalAction } from "../src/approval-controller";
import {
  ApprovalBroker,
  createApprovalExtension,
} from "../src/approval-feature";

const key = { scopeId: "/tmp/workspace", sessionId: "session-1" };

describe("ApprovalBroker", () => {
  test("authorizes uncaptured exact tool calls and uses captures only as policy evidence", async () => {
    const actions: FrozenApprovalAction[] = [];
    const controller = new ApprovalController({
      key,
      policy: (action) => {
        actions.push(action);
        return { boundary: { outcome: "allow", ruleId: "routine" } };
      },
    });
    controller.beginRun("run-1");
    const broker = new ApprovalBroker(controller);

    const direct = await broker.authorizeToolCall({
      toolCallId: "tool-1",
      toolName: "read",
      input: { path: "README.md" },
      cwd: "/tmp/workspace",
    });
    expect(direct).toMatchObject({ authorized: true, toolCallId: "tool-1", mode: "ask" });
    expect(actions[0]).toMatchObject({
      toolName: "read",
      inputCanonical: '{"path":"README.md"}',
      context: { cwd: "/tmp/workspace", permissionAsks: [] },
    });

    broker.capture({
      toolCallId: "tool-2",
      requestId: "permission-path",
      toolName: "write",
      detail: { kind: "path", path: "/tmp/outside" },
    });
    broker.capture({
      toolCallId: "tool-2",
      requestId: "permission-external",
      detail: { kind: "external_directory" },
    });
    const captured = await broker.authorizeToolCall({
      toolCallId: "tool-2",
      toolName: "write",
      input: { path: "/tmp/outside/file", content: "exact" },
      cwd: "/tmp/workspace",
    });
    expect(captured.authorized).toBe(true);
    expect(actions.find((action) => action.toolName === "write")?.context).toEqual({
      cwd: "/tmp/workspace",
      permissionAsks: [
        {
          detail: { kind: "path", path: "/tmp/outside" },
          requestId: "permission-path",
          toolName: "write",
        },
        {
          detail: { kind: "external_directory" },
          requestId: "permission-external",
        },
      ],
    });
    expect(broker.pendingFor("tool-2")).toEqual([]);
    expect(broker.dispositionFor("tool-2")).toEqual(captured);
  });
});

describe("approval inline feature", () => {
  test("checks every tool call, blocks invariants in Full, and clears settled dispositions", async () => {
    const controller = new ApprovalController({
      key,
      mode: "full",
      policy: (action) => ({
        ...(action.toolName === "danger"
          ? {
              invariantDeny: {
                outcome: "deny" as const,
                ruleId: "invariant.danger",
                rationale: "Danger remains blocked.",
              },
            }
          : {}),
        boundary: { outcome: "review", ruleId: "boundary" },
      }),
    });
    controller.beginRun("run-1");
    const broker = new ApprovalBroker(controller);
    const handlers = new Map<string, (event: Record<string, unknown>, context: { cwd: string }) => unknown>();
    const extension = createApprovalExtension({ broker });
    if (typeof extension === "function") throw new Error("expected named extension");
    extension.factory({
      on(event: string, handler: (event: Record<string, unknown>, context: { cwd: string }) => unknown) {
        handlers.set(event, handler);
      },
    } as never);

    const toolCall = handlers.get("tool_call");
    const toolResult = handlers.get("tool_result");
    if (!toolCall || !toolResult) throw new Error("approval handlers were not registered");

    expect(
      await toolCall(
        { type: "tool_call", toolCallId: "safe", toolName: "read", input: { path: "a" } },
        { cwd: "/tmp/workspace" },
      ),
    ).toBeUndefined();
    expect(broker.dispositionFor("safe")).toMatchObject({ authorized: true, mode: "full" });

    expect(
      await toolCall(
        { type: "tool_call", toolCallId: "blocked", toolName: "danger", input: { target: "/" } },
        { cwd: "/tmp/workspace" },
      ),
    ).toEqual({ block: true, reason: "Danger remains blocked.", terminate: false });
    expect(broker.dispositionFor("blocked")).toMatchObject({ authorized: false, outcome: "deny" });

    toolResult({ type: "tool_result", toolCallId: "safe" }, { cwd: "/tmp/workspace" });
    expect(broker.dispositionFor("safe")).toBeUndefined();
  });
});
