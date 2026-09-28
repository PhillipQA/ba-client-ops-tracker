# BA Client Ops Tracker v0.6.54

## FSD hard scope enforcement

- Advanced Mode module checkboxes are now authoritative. Unchecked MMS Feature, MMS Report, Lynexus Feature, or POS Feature sections are omitted from the AI schema, preview, table of contents, and Word export.
- The Document Agent receives explicit hard-exclusion instructions and cannot return excluded feature sections into the preview; unexpected excluded sections are discarded server-side before validation.
- Sources explicitly mapped to an unchecked module are not sent to FSD generation. Shared/unmapped sources remain available because they may contain requirements for selected modules.
- Section-specific mapping instructions for unchecked modules are not sent to the Document Agent.
- The first included software module now correctly receives the “5. Software Features” heading even when MMS Feature is unchecked.

No database migration or dependency installation is required.
