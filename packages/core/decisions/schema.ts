import { z } from "zod";

export const DecisionSchema = z.object({
  kind: z.string(), source_id: z.string(), issue_id: z.string(), issue_title: z.string(),
  project_id: z.string().nullable(), issue_revision: z.number(), agent_id: z.string().nullable(),
  response_id: z.string().nullable(), actor_id: z.string().nullable(), requested_at: z.string(),
  task_id: z.string().nullable(), question_seq: z.number().nullable(), sort_at: z.string(), status: z.string(),
  // A native row's answer receipt: `status` is open/queued/failed, `response_id`
  // the answer comment (the retry handle), and this the daemon's reason when a
  // failed steer gave one.
  receipt_reason: z.string().nullable().catch(null),
});
export const DecisionsPageSchema = z.object({
  items: z.array(DecisionSchema), pending_count: z.number().int().nonnegative(), next_cursor: z.string().nullable(),
});
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionsPage = z.infer<typeof DecisionsPageSchema>;
export interface DecisionsParams { state?: "pending" | "answered"; project_id?: string; cursor?: string; limit?: number }

export const DecisionDetailSchema = z.record(z.string(), z.unknown());
export type DecisionDetail = z.infer<typeof DecisionDetailSchema>;
