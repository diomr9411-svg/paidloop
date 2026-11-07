# Spike result: e-invoice in TypeScript (8 Nov 2026)

Run: `cd backend-ts/spike && npm i && npx xslt3 -xsl:rules.xslt -export:rules.sef.json -nogo && node spike.mjs`

| Check | Result |
|---|---|
| Input check by `@stackforge-eu/factur-x` (EN 16931 profile) | ok |
| Schema (XSD) check | ok |
| Official EN 16931 rules (61 rules) through Saxon-JS, good invoice | ok, no failed rule |
| Same rules on a wrong total | catches BR-CO-15 |
| ZUGFeRD PDF with XML inside, fonts and sRGB profile embedded, no PDF/A warning | ok, XML reads back |

Notes
- The rules file is the same EU XSLT the Python version uses. Compile once (about 45 s) to `rules.sef.json`; a check then takes about 1 s.
- Saxon-JS licence (Saxonica) allows use inside an app, not hosting the package for others. List it in THIRD_PARTY_NOTICES before release.
- The library asks for a delivery date in the EN 16931 profile. The legal check in our app already requires a service date.
- Not yet proven by an outside PDF/A validator (the Python version was not either).
