// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("rejects malformed response receipts", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "incomplete" }), { status: 200 })));
  const client = new ApiClient("https://api.example.test");
  await expect(client.respondDecision("issue-1", { client_request_id: "request", expected_issue_revision: 1, decision: "Approve", next_status: "in_progress" })).rejects.toThrow("Invalid Decision response receipt");
});
