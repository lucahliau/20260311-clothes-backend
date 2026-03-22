/**
 * Apple App Site Association payload for Universal Links (password reset).
 * @see https://developer.apple.com/documentation/xcode/supporting-associated-domains
 */
export function buildAppleAppSiteAssociation(appId: string) {
  return {
    applinks: {
      apps: [],
      details: [
        {
          appID: appId,
          paths: ["/reset-password", "/reset-password/*"],
        },
      ],
    },
  };
}
