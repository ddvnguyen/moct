-- Add Freebuff (headless orchestrator) next to Devin. The Freebuff line shipped
-- its own 593_runtime_profile_add_freebuff, which replaced the whole whitelist;
-- upstream's 593_runtime_profile_add_devin does the same. Whichever ran last
-- would silently drop the other family for new rows, so this migration states
-- the union once. Safe on a database that already applied either of them.
-- Expand the current whitelist without scanning historical rows. Replacing
-- both parts in one ALTER keeps the constraint present atomically.
ALTER TABLE runtime_profile
    DROP CONSTRAINT IF EXISTS runtime_profile_protocol_family_check,
    ADD CONSTRAINT runtime_profile_protocol_family_check
    CHECK (protocol_family IN (
        'claude',
        'codebuddy',
        'codex',
        'copilot',
        'opencode',
        'codearts',
        'openclaw',
        'hermes',
        'pi',
        'cursor',
        'kimi',
        'reasonix',
        'dsh',
        'kiro',
        'antigravity',
        'qoder',
        'qoderclicn',
        'traecli',
        'deveco',
        'grok',
        'qwen',
        'qwenpaw',
        'mcode',
        'muse',
        'dim',
        'zeroclaw',
        'devin',
        'freebuff'
    )) NOT VALID;
