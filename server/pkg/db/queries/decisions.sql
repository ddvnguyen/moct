-- name: ListDecisions :one
WITH scoped_issues AS MATERIALIZED (
    SELECT id, workspace_id, project_id, status, updated_at, title, revision FROM issue
    WHERE workspace_id = sqlc.arg(workspace_id)::uuid
      AND (sqlc.narg(project_id)::uuid IS NULL OR project_id = sqlc.narg(project_id)::uuid)
), native AS MATERIALIZED (
    SELECT t.issue_id, t.id AS task_id, t.agent_id, m.seq, m.created_at
    FROM agent_task_queue t
    JOIN scoped_issues i ON i.id = t.issue_id
    JOIN task_supplement_capability c ON c.task_id = t.id AND c.workspace_id = i.workspace_id
      AND c.capability = 'task-supplement-v1'
    JOIN LATERAL (
        SELECT tm.seq FROM task_message tm WHERE tm.task_id = t.id ORDER BY tm.seq DESC LIMIT 1
    ) latest ON true
    JOIN LATERAL (
        SELECT tm.seq, tm.created_at, tm.input FROM task_message tm
        WHERE tm.task_id = t.id AND tm.seq = latest.seq
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(tm.input->'questions') = 'array' THEN tm.input->'questions' ELSE '[]'::jsonb END
          ) q WHERE jsonb_typeof(q->'question') = 'string'
            AND length(btrim(q->>'question', U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0)
        ORDER BY tm.seq DESC LIMIT 1
    ) m ON true
    WHERE t.status = 'running' AND m.created_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM task_supplement s WHERE s.task_id = t.id
          AND s.workspace_id = i.workspace_id AND s.status = 'delivered' AND date_trunc('milliseconds', s.delivered_at) >= date_trunc('milliseconds', m.created_at))
), pending AS MATERIALIZED (
    SELECT 'question'::text AS kind, c.id::text AS source_id, c.issue_id, c.agent_id,
           c.created_at AS sort_at, c.task_id, NULL::integer AS question_seq, c.status, NULL::uuid AS response_id, NULL::uuid AS actor_id, c.created_at AS requested_at
    FROM agent_question_card c JOIN scoped_issues i ON i.id = c.issue_id
    WHERE c.workspace_id = i.workspace_id AND c.status = 'open'
    UNION ALL
    SELECT 'plan', p.id::text, p.issue_id, p.agent_id, p.updated_at, p.task_id, NULL::integer, p.status, NULL::uuid, NULL::uuid, p.updated_at
    FROM agent_plan p JOIN scoped_issues i ON i.id = p.issue_id
    WHERE p.workspace_id = i.workspace_id AND p.status = 'in_review'
    UNION ALL
    SELECT 'native', n.task_id::text || ':' || n.seq::text, n.issue_id, n.agent_id, n.created_at, n.task_id, n.seq, 'open', NULL::uuid, NULL::uuid, n.created_at
    FROM native n
    UNION ALL
    SELECT 'status', i.id::text, i.id, NULL::uuid, i.updated_at, NULL::uuid, NULL::integer, i.status, NULL::uuid, NULL::uuid, i.updated_at
    FROM scoped_issues i WHERE i.status = 'wait_for_decision'
      AND NOT EXISTS (SELECT 1 FROM agent_question_card c WHERE c.issue_id = i.id AND c.workspace_id = i.workspace_id AND c.status = 'open')
      AND NOT EXISTS (SELECT 1 FROM agent_plan p WHERE p.issue_id = i.id AND p.workspace_id = i.workspace_id AND p.status = 'in_review')
      AND NOT EXISTS (SELECT 1 FROM native n WHERE n.issue_id = i.id)
), visible_pending AS MATERIALIZED (
    SELECT * FROM pending WHERE agent_id IS NULL OR agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
), history AS (
    SELECT 'question'::text AS kind, c.id::text AS source_id, c.issue_id, c.agent_id,
           COALESCE(c.answered_at, c.withdrawn_at) AS sort_at, c.task_id, NULL::integer AS question_seq, c.status, c.id AS response_id, c.answered_by AS actor_id, c.created_at AS requested_at
    FROM agent_question_card c JOIN scoped_issues i ON i.id = c.issue_id
    WHERE c.workspace_id = i.workspace_id AND c.status IN ('answered', 'withdrawn') AND COALESCE(c.answered_at, c.withdrawn_at) IS NOT NULL
      AND c.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
    UNION ALL
    SELECT 'plan', p.id::text || ':' || r.id::text, p.issue_id, p.agent_id, r.created_at, p.task_id, NULL::integer, r.verdict, r.id, r.reviewed_by, p.created_at
    FROM agent_plan_review r JOIN agent_plan p ON p.id = r.plan_id
    JOIN scoped_issues i ON i.id = p.issue_id
    WHERE p.workspace_id = i.workspace_id AND p.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
    UNION ALL
    SELECT 'plan', p.id::text, p.issue_id, p.agent_id, p.cancelled_at, p.task_id, NULL::integer, p.status, NULL::uuid, NULL::uuid, p.created_at
    FROM agent_plan p JOIN scoped_issues i ON i.id = p.issue_id
    WHERE p.workspace_id = i.workspace_id AND p.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
      AND p.status = 'cancelled' AND p.cancelled_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agent_plan_review r WHERE r.plan_id = p.id AND r.verdict = 'cancel')
), selected AS (
    SELECT * FROM visible_pending WHERE sqlc.arg(state)::text = 'pending'
    UNION ALL
    SELECT * FROM history WHERE sqlc.arg(state)::text = 'answered'
), page AS (
    SELECT s.*, i.title AS issue_title, i.project_id, i.revision AS issue_revision
    FROM selected s JOIN scoped_issues i ON i.id = s.issue_id
    WHERE sqlc.narg(cursor_time)::timestamptz IS NULL
      OR (sqlc.arg(state)::text = 'pending' AND (s.sort_at, s.kind, s.source_id) > (sqlc.narg(cursor_time)::timestamptz, sqlc.arg(cursor_kind)::text, sqlc.arg(cursor_id)::text))
      OR (sqlc.arg(state)::text = 'answered' AND (s.sort_at, s.kind, s.source_id) < (sqlc.narg(cursor_time)::timestamptz, sqlc.arg(cursor_kind)::text, sqlc.arg(cursor_id)::text))
    ORDER BY CASE WHEN sqlc.arg(state)::text = 'pending' THEN s.sort_at END ASC,
             CASE WHEN sqlc.arg(state)::text = 'pending' THEN s.kind END ASC,
             CASE WHEN sqlc.arg(state)::text = 'pending' THEN s.source_id END ASC,
             s.sort_at DESC, s.kind DESC, s.source_id DESC LIMIT sqlc.arg(page_limit)::integer
)
SELECT jsonb_build_object(
    'pending_count', (SELECT count(*) FROM visible_pending),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY CASE WHEN sqlc.arg(state)::text = 'pending' THEN sort_at END ASC, CASE WHEN sqlc.arg(state)::text = 'pending' THEN kind END ASC, CASE WHEN sqlc.arg(state)::text = 'pending' THEN source_id END ASC, sort_at DESC, kind DESC, source_id DESC) FROM page), '[]'::jsonb)
)::jsonb AS result;

-- name: GetDecisionDetail :one
SELECT payload FROM (
  SELECT to_jsonb(c) AS payload FROM agent_question_card c
  WHERE sqlc.arg(kind)::text = 'question' AND c.workspace_id = sqlc.arg(workspace_id)::uuid
    AND c.id = sqlc.arg(source_id)::uuid AND c.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
  UNION ALL
  SELECT jsonb_build_object('plan', to_jsonb(p), 'review', to_jsonb(r))
  FROM agent_plan p LEFT JOIN agent_plan_review r ON r.plan_id = p.id AND r.id = sqlc.narg(response_id)::uuid
  WHERE sqlc.arg(kind)::text = 'plan' AND p.workspace_id = sqlc.arg(workspace_id)::uuid
    AND p.id = sqlc.arg(source_id)::uuid AND p.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
    AND (sqlc.narg(response_id)::uuid IS NULL OR r.id IS NOT NULL)
  UNION ALL
  SELECT jsonb_build_object('task_id', t.id, 'message', to_jsonb(m))
  FROM agent_task_queue t JOIN issue i ON i.id=t.issue_id
  JOIN task_message m ON m.task_id=t.id AND m.seq=sqlc.arg(question_seq)::integer
  WHERE sqlc.arg(kind)::text = 'native' AND i.workspace_id=sqlc.arg(workspace_id)::uuid
    AND t.id=sqlc.arg(source_id)::uuid AND t.agent_id = ANY(sqlc.arg(visible_agents)::uuid[])
  UNION ALL
  SELECT jsonb_build_object('id', i.id, 'title', i.title, 'description', i.description, 'revision', i.revision, 'status', i.status)
  FROM issue i WHERE sqlc.arg(kind)::text = 'status' AND i.workspace_id=sqlc.arg(workspace_id)::uuid AND i.id=sqlc.arg(source_id)::uuid
) details LIMIT 1;
