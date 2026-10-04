# Fixture scrub rules (round 3, owner should-fix #2)

`tests/fixtures/seed.sql` is generated from the live orchestration ledger but
checked into a PUBLIC repo. The raw dump contained machine-local values; the
checked-in file is scrubbed by VALUE SUBSTITUTION ONLY — no rows/columns are
dropped, so parity still runs on the same shape (all 10 table counts verified
identical before/after; see below).

## Rules (applied in order)

| #   | Pattern                                                                                                      | Replacement            | Hits in raw dump |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------- | ---------------- |
| 1   | `/home/ddv`                                                                                                  | `/path/to/home`        | 179              |
| 2   | `/mnt/WorkDisk`                                                                                              | `/path/to/work`        | 513              |
| 3   | `/mnt/workspace`                                                                                             | `/path/to/workspace`   | 14               |
| 4   | `hydra.app.01@gmail.com`                                                                                     | `operator@example.com` | 3                |
| 5   | bare token `ddv` (unix username in free text; NOT inside `ddvnguyen`, `ddvnguyen02`, paths, or longer words) | `operator`             | 2                |

## Deliberately kept

- `ddvnguyen/...` repo slugs (227 occurrences) — the owner's own PUBLIC
  GitHub handle, intrinsic to the data (validated repo names, track goals
  naming PRs). Scrubbing them would destroy meaning; they carry no more
  exposure than the repo URL itself.
- `ddvnguyen02` (1 occurrence) — public handle variant in prose, same reason.
- Generic system paths (`/usr/bin`, cron shapes) and prose about auth
  (`Bearer auth` in design text, not tokens). A scan for `ghp_|gho_|sk-ant-|
sk-proj-|AKIA|xox[bap]-` plus real `user@host.tld` emails found exactly one
  address (rule 4) and zero credential patterns.

## Enforcement

- `scripts/regenerate-fixture.mjs` applies rules 1–5 to every regeneration and
  THROWS (refusing to write) if `/home/ddv`, `/mnt/WorkDisk`,
  `/mnt/workspace`, or `@gmail.com` survive. A future regen cannot silently
  reintroduce the raw values.
- Shape check after any scrub/regen: per-table `INSERT INTO <table>(` counts
  must match the generation header; banned-pattern grep must be empty:

```
for t in orch_projects orch_tracks orch_tasks orch_workers orch_turns \
         orch_events orch_decisions orch_suggestions orch_model_evaluations meta; do
  grep -c "INSERT INTO $t(" tests/fixtures/seed.sql
done
grep -c "/home/ddv\|/mnt/WorkDisk\|/mnt/workspace\|@gmail.com" tests/fixtures/seed.sql
# expect 0 (grep exits 1)
```

## Residual exposure (history rewrite caveat)

The raw seed lived in earlier commits on `feat/fleet-backend-m1`. Branch
history was rewritten (owner-sanctioned) so the scrubbed file replaces the raw
one at every commit, then force-pushed. This limits ONWARD spread, not
retroactive exposure: already-public objects may persist in GitHub
caches/forks. Verified post-rewrite: at every commit touching the fixture,
grep for `/home/ddv` + the redacted email returns zero hits.
