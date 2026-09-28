# Functional verification — v0.6.59

- Production TypeScript/Vite build, server type check and FSD scope tests passed.
- Browser extraction used the exact two-page EGGCELSIOR inventory report PDF with the app's PDF.js and Tesseract browser path. The previous version returned about 3,274 characters and missed key headings in screenshot tables. This version returned about 4,518 characters, kept selectable transaction rows, and recovered the inventory-by-size, withdrawals, aging, disposals and raw-data sections.
- The test also confirmed that embedded screenshots were handled individually rather than relying on the full-page OCR fallback, and duplicate screenshot text did not repeat on page two.
- Both distribution ZIPs passed integrity checking. Applying the patch to the v0.6.58 full build matched the v0.6.59 full build byte for byte, and rollback restored the baseline.

The browser test validates extraction, not the live Document Agent or final Word output. The user's AI credentials, hosted deployment and security behavior were not tested. OCR may misread sample figures, units and small labels; human review remains necessary.
