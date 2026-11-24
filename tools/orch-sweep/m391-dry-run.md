# M-391 dry run: `--illegal-endings --hours 168` (7 days, live board, read-only)

- 31 issues scanned, 479 agent comments checked, 23 offenders.
- Signal mix: next-unnamed 20, standing-by 1, waiting-for-review 1, role-needed 1.
- No card writes, no metadata writes (mode only prints JSON).

## Samples (4 read in full, all true contract violations)

- M-330 `01a1d54c` (Lead): "Standing by: Freebuff Engineer's run carries plan v1 implementation." — turn ended with no trigger; the other run it waits on is not armed from this turn.
- M-301 `01a1e640` ([Go Free] Engineer): delivery comment ending "**Next:** review/merge per gate, then deploy…" — names no owner and triggers nobody.
- M-175 `01a1dcbc` (Orchestrator): "Next: Software Engineer fixes `frontend-test`…" — names a role, not a mention/assign; role names are not addresses.
- M-237 `01a1cb89` (Claude Architect): "next step" question to nobody with no ask card.

## Known false positive (1/23)

- M-391 `01a1e54d` (Claude Architect): "where Terra ended with 'lane operator / Claude Architect needed'" — a meta-mention *reporting* a violation, not committing one. Quote-aware exclusion was rejected: stripping quoted spans would hide real violations phrased as quotes. The daily-ticket reader judges these.

## Full offender list

- M-175 | 01a1dcbc-43e4-7d7f-978b-c0b57669a20a | Orchestrator | 2026-11-15T01:04:48Z | next-unnamed
- M-175 | 01a1dfee-5dc7-7867-b2f8-c3cdf0a83357 | Claude Architect | 2026-11-15T15:58:23Z | next-unnamed
- M-237 | 01a1cb6a-23c5-746e-b703-99d887288e99 | Claude Architect | 2026-11-11T16:21:33Z | next-unnamed
- M-237 | 01a1cb89-5fb9-7736-b61b-becdc4ca98b4 | Claude Architect | 2026-11-11T16:55:40Z | next-unnamed
- M-237 | 01a1d4db-0b14-765b-b22a-c192be946c0f | Claude Architect | 2026-11-13T12:21:27Z | next-unnamed
- M-237 | 01a1d515-9ed1-718e-a585-08f483de4979 | Claude Architect | 2026-11-13T13:25:26Z | next-unnamed
- M-237 | 01a1d521-f2bb-74c0-8d66-7255e5bc53c8 | Claude Architect | 2026-11-13T13:38:54Z | next-unnamed
- M-237 | 01a1d9ff-39f6-77dc-b859-d7c2ed77539d | Claude Architect | 2026-11-14T12:19:04Z | next-unnamed
- M-290 | 01a1d9e6-8148-7ecf-97a7-52a6783f9c98 | Lead | 2026-11-14T11:52:04Z | next-unnamed
- M-301 | 01a1e640-4398-7c65-bcc6-63a464420f6e | [Go Free] Engineer | 2026-11-16T21:25:33Z | next-unnamed
- M-301 | 01a1e646-e687-7c96-a496-00394b2996f2 | [Go Free] Engineer | 2026-11-16T21:32:48Z | next-unnamed
- M-325 | 01a1da15-a0b3-741b-a609-9d611eb21df2 | Claude Architect | 2026-11-14T12:43:32Z | next-unnamed
- M-330 | 01a1d54c-e638-75fa-a479-df0b78c7afb8 | Lead | 2026-11-13T14:25:49Z | standing-by
- M-330 | 01a1d766-271a-771b-afa0-ef7fe91ac8f0 | Orchestrator | 2026-11-14T00:12:38Z | waiting-for-review
- M-336 | 01a1dcb9-2e78-7122-8faa-5bb24c65a773 | Opencode2 | 2026-11-15T01:01:26Z | next-unnamed
- M-336 | 01a1df4b-71b3-7d1b-af4d-fc44b09a9c16 | Claude Architect | 2026-11-15T13:00:25Z | next-unnamed
- M-360 | 01a1df9b-51b6-753d-8283-dfe5905caf68 | Claude Architect | 2026-11-15T14:27:40Z | next-unnamed
- M-362 | 01a1dfc7-711e-7569-83ff-c0cd471c7bc1 | Software Engineer | 2026-11-15T15:15:52Z | next-unnamed
- M-375 | 01a1e003-19ef-799c-b41a-b9edcc8c7491 | Software Engineer | 2026-11-15T16:21:02Z | next-unnamed
- M-375 | 01a1e01b-3a5e-7f1b-b74d-4655e949fb6d | Software Engineer | 2026-11-15T16:47:23Z | next-unnamed
- M-375 | 01a1e171-9b40-7ad6-974e-b18a74a3016b | Orchestrator (Backup) | 2026-11-15T23:01:21Z | next-unnamed
- M-391 | 01a1e54d-47f4-7a8e-ad05-701e81e25547 | Claude Architect | 2026-11-16T17:00:09Z | role-needed (meta-mention FP, see above)
- M-97 | 01a1d4f6-5ee0-7d41-bb08-5d9e612c86ea | Orchestrator | 2026-11-13T12:51:18Z | next-unnamed
