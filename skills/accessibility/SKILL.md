---
name: accessibility
description: Accessibility rules for Matrix projects (web, mobile, desktop UIs) — semantics, keyboard, focus, contrast, motion and screen readers. Use when building or reviewing any user interface.
---

# Accessibility

Target WCAG 2.2 AA.

## Semantics

- Use native elements (`button`, `a`, `label`, `input`) before ARIA. A clickable `div` is a bug.
- Every form control has a visible label; errors are linked with `aria-describedby`.
- One `h1` per page; headings in order. Landmarks: `header`, `nav`, `main`, `footer`.
- React Native: set `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on custom controls.

## Keyboard and focus

- Everything works with the keyboard alone; focus order follows visual order.
- Focus is always visible (never `outline: none` without a replacement).
- Dialogs trap focus and return it to the trigger on close; Escape closes them.

## Visuals

- Text contrast ≥ 4.5:1 (3:1 for large text and UI components), in light and dark themes.
- Don't convey meaning by colour alone; pair status colours with text or icons.
- Respect `prefers-reduced-motion` and the OS text-size setting.

## Checks

- Automated: axe (Playwright `@axe-core/playwright`) on every page in e2e; it catches about a third of issues.
- Manual per release: keyboard-only pass, screen reader smoke test (VoiceOver/TalkBack).
