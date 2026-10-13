---
name: expo-react-native
description: Quality rules for the Expo (React Native, expo-router) mobile app in a Matrix project — navigation, data, styling, native builds, OTA updates and device QA. Use when writing or reviewing mobile screens or mobile release config.
---

# Expo / React Native quality

## Navigation (expo-router)

- Screens live in `app/` as file routes; layouts in `_layout.tsx`. No react-navigation setup by hand (ADR rule).
- Typed routes are on: use `href` objects, never string-concatenated paths.
- Deep links use the app `scheme`; test them with `npx uri-scheme open`.

## Data

- TanStack Query with `focusManager` wired to `AppState` and `onlineManager` to NetInfo so refetch follows the app lifecycle.
- Persist the query cache only for data that is safe offline; never persist auth tokens there (use `expo-secure-store`).

## Rendering and performance

- Lists use `FlatList`/`FlashList` with stable `keyExtractor`; never `.map()` long lists in a `ScrollView`.
- Memoize row components; avoid inline objects in hot props.
- Animations run on the UI thread (Reanimated worklets), not in JS timers.
- Images have explicit sizes; use `expo-image` for caching.

## Styling

- One system per the styling ADR (NativeWind classes, Tamagui, or StyleSheet). Don't mix.
- Respect safe areas (`react-native-safe-area-context`) and dynamic type.

## Native and releases

- Native changes go through config plugins in `app.json`; never commit `ios/` or `android/` (CNG).
- `expo install --check` must pass: Expo pins compatible native versions.
- EAS Build profiles: development, preview, production. Secrets live in EAS, not the repo.
- EAS Update ships JS-only fixes; bump the runtime version when native code changes.

## QA

- Maestro flows in `.maestro/` are the receipts: launch, navigate, assert visible text, screenshot.
- Run them on Orca's simulators/emulators or agent-device; attach screenshots and videos to the ticket.

Further reading: the React Native and Vercel React Native skills (MIT) go deeper on performance.
