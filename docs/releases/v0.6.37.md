# v0.6.37 — AI Agent Manager

Upgrade path: **v0.6.36 → v0.6.37**.

This release separates the general BA Assistant from Document Creation AI. Each tenant can configure a different provider, model, API key and enable/disable state for each agent.

## Agent routing

| Agent | Current responsibilities | Context boundary |
| --- | --- | --- |
| **BA Assistant** | AI BA Assistant, supported Discord inquiry assessment | Authenticated user's permission-filtered clients, projects, tasks, activities and work history |
| **Document Agent** | FSD Creator, Test Case Creator AI, DRF AI Enhanced COR mapping | Uploaded/extracted document text, selected presets, document metadata and template structure |

Existing tenant AI credentials are preserved as **Legacy Shared AI (Fallback)**. If a dedicated agent is not configured, that agent continues to use the legacy credential so upgrading does not immediately break existing AI workflows.

## Supabase migration required for dedicated agents

Run this migration in Supabase SQL Editor before saving a separate BA Assistant or Document Agent credential:

```text
supabase/schema-v11-ai-agent-manager.sql
```

The migration creates `tenant_ai_agents` with one row per tenant/agent. It is non-destructive and rerunnable. It does not delete or rewrite `tenant_integrations`.

The existing `TENANT_INTEGRATION_MASTER_KEY` remains the encryption master key. No new Render environment variable is required.

## Account Settings

Account Administrators now see **AI Agent Manager** with two cards:

- BA Assistant
- Document Agent

Each card supports provider, model ID, encrypted API key, enable/disable, connection test, and removal of the dedicated configuration. Removing a dedicated configuration causes that agent to fall back to Legacy Shared AI when one exists.

A legacy shared AI card remains visible during migration for compatibility and credential management.

## Apply and deploy

From the existing v0.6.36 project folder:

```bat
cd /d E:\Playwright\ba-client-ops-tracker
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.37-ai-agent-manager.zip"
npm run patch:status
npm run build
```

Then run `supabase/schema-v11-ai-agent-manager.sql` and deploy through the normal Render workflow.

No new npm dependency is required.

## Suggested setup

A practical starting configuration is:

- **BA Assistant:** Gemini provider with the tenant's preferred fast BA model.
- **Document Agent:** OpenAI or Gemini using the tenant's preferred higher-quality document model.

The model IDs remain editable because provider availability can differ by account.

## Verification

1. Sign in as a tenant Administrator and open **Settings → AI Agent Manager**.
2. Confirm both agents are displayed.
3. Before the migration, confirm the UI says separate agent storage is not installed while legacy AI still acts as fallback.
4. Run `schema-v11-ai-agent-manager.sql`, refresh Settings, and save the BA Assistant agent.
5. Save a separate Document Agent using either the same or a different provider/model/API key.
6. Test both agent connections.
7. Open AI BA Assistant and confirm normal assessment works.
8. Open Document Creation → FSD and confirm the status identifies **Document Agent** and can generate a preview.
9. If used, verify Test Case Creator and DRF AI Enhanced also use Document Agent.
10. Verify Discord inquiry capture still works; AI enrichment should use BA Assistant when configured and basic capture should still work if AI is unavailable.

Rollback if needed with `npm run patch:rollback`, rebuild, and redeploy. The new Supabase table can remain unused after rollback without affecting earlier releases.
