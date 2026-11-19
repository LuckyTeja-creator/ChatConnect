# ChatConnect — Phone-friendly Expo project

## What this starter includes
- Premium dark chat UI
- Email/password Firebase Authentication screen
- SQLite local message store and outbox queue
- Network status indicator
- Queued outgoing messages with retry when internet returns
- Firestore shared lobby listener and message upload scaffold
- EAS profiles for APK preview and Play Store AAB release

## Important before using real accounts
1. Create a Firebase project.
2. Add an Android/Web app in Firebase Console and copy the Firebase web config into `firebaseConfig.js`.
3. In Firebase Authentication, enable Email/Password.
4. Create a Cloud Firestore database.
5. Publish secure Firestore rules. Do not use public read/write rules in production.
6. This is a starter implementation, not a production-ready messenger. It currently uses one shared demo lobby, not private one-to-one chats or groups. Message encryption, moderation, block/report, account deletion, push notifications, media upload, and robust conflict handling still need implementation and security review before public release.
7. Do not share your Firebase service account private key or passwords.

## Build from a phone
Use a browser-based cloud development environment that supports a terminal (for example, a cloud IDE). Upload/extract this project, run `npm install`, then `npx expo install --check` and resolve any SDK compatibility warnings. Sign in to Expo with `npx eas login`, configure with `npx eas build:configure`, then build an installable test APK with `npx eas build --platform android --profile preview`.

For Google Play, use the production profile to create an AAB: `npx eas build --platform android --profile production`.

A phone browser alone cannot run the Android native build locally; EAS performs the build in the cloud. You will need an Expo account. Google Play publishing also requires a Play Console developer account and compliance with current Google policies.

## Offline behavior
Messages typed while offline are inserted into SQLite and the outbox. When connectivity returns, the app retries upload using the same message ID, so the Firestore document ID is stable across retries. A message is shown as pending until Firestore accepts it. Delivery/read receipts are not implemented in this starter.

## Test checklist
- Create account while online.
- Sign out and sign in again.
- Send a message while online and check it appears on a second signed-in device.
- Turn on airplane mode and send a message; verify it remains pending.
- Reconnect and verify it uploads once.
- Restart the app and verify locally stored messages remain.
