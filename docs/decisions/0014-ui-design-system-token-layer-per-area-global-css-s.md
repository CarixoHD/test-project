# 0014. UI design system: token layer + per-area global CSS, self-hosted variable fonts, light/dark themes, screenshot-verified restyles

Date: 2026-11-20 · Status: Accepted

## Context

The owner reports the UI looks unstyled (browser-default fonts on Linux because --font-sans falls back from 'Segoe UI Variable' to system-ui, bare forms). All styling lives in one 1300-line src/web/styles.css with BEM-like global classes; ARCHITECTURE §2 says 'CSS Modules + CSS variables' but the code never adopted modules. A design pass must run as several parallel restyle issues, which all would edit that one file and collide at merge. There is no DESIGN.md and no dark mode.

## Options considered

- **Migrate to CSS Modules during the restyle**: Matches the original ARCHITECTURE line, scoped class names. But every component's className changes, tests/E2E that touch classes churn, and each restyle issue becomes a refactor plus a redesign: too big per issue.
- **Adopt a CSS framework (Tailwind / component library)**: Fast to look polished, but adds a build dependency and a second styling system next to the existing accessible primitives; ADR 2 chose no CSS framework.
- **Keep global BEM classes, split into a token layer + per-area CSS files (chosen)**: tokens.css (light + dark), base.css, primitives.css, then one CSS file per feature folder imported by that feature. Pure move first (no visual change), then each restyle issue owns disjoint files.

## Decision

1) Split styles.css into src/web/styles/{tokens,base,primitives}.css plus one CSS file per area (features/<area>/<area>.css, scene/scene.css) with no visual change. 2) DESIGN.md defines the system; all colours, type, spacing, radii, shadows and motion are CSS custom properties in tokens.css, with a dark theme via prefers-color-scheme and a data-theme override (System/Light/Dark toggle stored in localStorage). 3) Fonts are self-hosted from npm @fontsource-variable packages bundled by Vite (no Google Fonts CDN: the app is self-hosted and may run offline, and must not leak requests). 4) A repeatable screenshot harness (Playwright, demo mode) captures every page at desktop 1440×900 and phone 390×844 in light and dark, and asserts no horizontal page overflow for areas already restyled. 5) One restyle issue per area, each verified with those screenshots; a final consistency QA pass at the end.

## Rationale

Lowest-risk path to a polished UI: keeps the tested accessible primitives and class names, lets restyle issues run in parallel without merge conflicts, and gives reviewers objective visual evidence (screenshots + overflow assertion) instead of claims. Self-hosted fonts keep the localhost-only privacy promise (PRD access/security).
