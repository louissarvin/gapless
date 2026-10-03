/**
 * In-app browser detection (ARCHITECTURE route map, `/` row). In-app browsers
 * (Telegram, Instagram, Line, WeChat, X/Twitter) commonly break or disable
 * WebAuthn; users must be redirected to Safari or Chrome before any ceremony.
 */
const IN_APP_MARKERS = [
  'FBAN',
  'FBAV',
  'Instagram',
  'Line/',
  'MicroMessenger',
  'TikTok',
  'Twitter',
  'Pinterest',
  'Snapchat',
  'TelegramBot',
] as const

export function isInAppBrowser(
  userAgent: string = navigator.userAgent,
): boolean {
  return IN_APP_MARKERS.some((marker) => userAgent.includes(marker))
}
