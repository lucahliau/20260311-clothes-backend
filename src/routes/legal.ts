import { Router, Request, Response } from "express";

/**
 * Public legal pages (privacy policy + terms of service), served straight from
 * the API host so the App Store listing and the in-app links have a stable,
 * always-online URL. Root-level and unversioned, like /reset-password.
 *
 * If a marketing domain ever exists, these can move there — keep the paths
 * (/privacy, /terms) identical so shipped app builds don't break.
 */

const EFFECTIVE_DATE = "June 12, 2026";
const CONTACT_EMAIL = "support@clothedd.app";

const SHARED_CSS = `
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1.25rem 4rem; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; }
  .meta { color: #555; font-size: 0.9rem; margin-bottom: 2rem; }
  ul { padding-left: 1.25rem; }
  a { color: #0a58ca; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Clothedd</title>
  <style>${SHARED_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

const PRIVACY_HTML = page(
  "Privacy Policy",
  `
  <h1>Clothedd Privacy Policy</h1>
  <p class="meta">Effective ${EFFECTIVE_DATE}</p>

  <p>Clothedd ("we", "us") is a clothing discovery app. This policy explains what
  information we collect when you use the Clothedd iOS app, how we use it, and the
  choices you have. We do not sell your personal information, and we do not show
  third-party advertising or use cross-app tracking.</p>

  <h2>Information we collect</h2>
  <ul>
    <li><strong>Account information.</strong> Email address, username, and password
    (stored only as a salted hash). If you sign in with Apple, we receive the
    identifier and email Apple shares with us instead of a password.</li>
    <li><strong>Optional profile details.</strong> Name, profile photo, date of birth,
    gender, location, bio, style preferences, favorite brands, and preferred sizes —
    only if you choose to add them.</li>
    <li><strong>Content you create.</strong> Messages you send to other users, items
    you like or skip, collections, and wardrobe selections.</li>
    <li><strong>Social connections.</strong> Who you follow, friend, or block within
    the app.</li>
    <li><strong>Device and diagnostic data.</strong> A per-install device identifier
    (used to keep you signed in securely per device), a push notification token if
    you enable notifications, anonymous crash and error diagnostics (app version,
    OS version), and standard server logs (IP address, request timestamps).</li>
  </ul>

  <h2>How we use it</h2>
  <ul>
    <li>To provide the app: accounts, the discovery feed, messaging, social features,
    and personalized recommendations based on items you like.</li>
    <li>To secure the service: sign-in, session management, rate limiting, and abuse
    prevention (including reviewing user reports).</li>
    <li>To communicate with you: account emails such as email verification, password
    resets, and security notices. We do not send marketing email.</li>
    <li>To fix problems: crash diagnostics and error monitoring.</li>
  </ul>

  <h2>Who processes your data</h2>
  <p>We use a small set of service providers to run Clothedd, each processing data
  only on our behalf: Railway (application hosting), Supabase (database hosting),
  Cloudflare (image storage and delivery), Resend (transactional email), Sentry
  (error monitoring), and Apple (push notifications and Sign in with Apple). We do
  not share your personal information with anyone else except when required by law.</p>

  <h2>Catalog content</h2>
  <p>Product listings shown in the app (brands, prices, product images) are catalog
  data about clothing items, not personal data. Product names and trademarks belong
  to their respective owners.</p>

  <h2>Retention and deletion</h2>
  <p>We keep your data while your account is active. You can delete your account at
  any time in the app under <strong>Settings → Account → Delete account</strong>;
  this permanently deletes your profile, messages, likes, collections, social
  connections, and sessions. Server logs and crash diagnostics are retained briefly
  for security and debugging, then deleted. You can also email us to request
  deletion or a copy of your data.</p>

  <h2>Your choices</h2>
  <ul>
    <li>Edit or remove profile details in Settings at any time.</li>
    <li>Disable push notifications in iOS Settings.</li>
    <li>Block or report other users from within the app.</li>
    <li>Delete your account in the app, or by emailing us.</li>
  </ul>

  <h2>Children</h2>
  <p>Clothedd is not directed at children under 13 (or the minimum age required in
  your country), and we do not knowingly collect data from them. If you believe a
  child has created an account, contact us and we will delete it.</p>

  <h2>Security</h2>
  <p>All traffic between the app and our servers uses TLS (HTTPS). Passwords are
  stored only as salted bcrypt hashes, and sign-in tokens are stored hashed.</p>

  <h2>Changes</h2>
  <p>If we make material changes to this policy, we will update this page and the
  effective date above.</p>

  <h2>Contact</h2>
  <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`,
);

const TERMS_HTML = page(
  "Terms of Service",
  `
  <h1>Clothedd Terms of Service</h1>
  <p class="meta">Effective ${EFFECTIVE_DATE}</p>

  <p>These terms govern your use of the Clothedd iOS app. By creating an account or
  using the app you agree to them. If you do not agree, do not use Clothedd.</p>

  <h2>Eligibility and accounts</h2>
  <p>You must be at least 13 years old (or the minimum age required in your country)
  to use Clothedd. You are responsible for your account and for keeping your
  sign-in credentials private. Provide accurate information and do not impersonate
  anyone.</p>

  <h2>Acceptable use and content rules</h2>
  <p>Clothedd has <strong>no tolerance for objectionable content or abusive
  behavior</strong>. You agree not to:</p>
  <ul>
    <li>harass, threaten, or abuse other users;</li>
    <li>send spam or unsolicited promotion;</li>
    <li>post content that is unlawful, hateful, sexually explicit, or that you do
    not have the right to share;</li>
    <li>impersonate any person or misrepresent your affiliation;</li>
    <li>attempt to probe, disrupt, or gain unauthorized access to the service.</li>
  </ul>
  <p>You can <strong>block</strong> and <strong>report</strong> any user from within
  the app. We review reports and may remove content, restrict features, or suspend
  or terminate accounts that violate these terms, at our sole discretion and
  without prior notice.</p>

  <h2>Your content</h2>
  <p>You keep ownership of the content you create in Clothedd (messages, profile,
  collections). You grant us the limited license needed to host, display, and
  transmit that content to operate the service. We may remove content that
  violates these terms.</p>

  <h2>Catalog information</h2>
  <p>Clothedd displays clothing products from third-party brands and retailers for
  discovery purposes. We are not a store: we do not sell products, process
  payments, or fulfil orders. Prices and availability are indicative and may be
  out of date — always confirm details on the retailer's own site. Purchases you
  make on retailer sites are solely between you and that retailer. All product
  names, images, and trademarks belong to their respective owners; Clothedd is not
  affiliated with or endorsed by them.</p>

  <h2>Termination</h2>
  <p>You can stop using Clothedd and delete your account at any time in Settings.
  We may suspend or terminate accounts that violate these terms or harm the
  service or its users.</p>

  <h2>Disclaimers</h2>
  <p>Clothedd is provided "as is" without warranties of any kind. To the maximum
  extent permitted by law, we are not liable for indirect, incidental, or
  consequential damages arising from your use of the app, and our total liability
  is limited to the amount you paid us to use Clothedd (currently zero — the app
  is free).</p>

  <h2>Changes</h2>
  <p>We may update these terms; material changes will be reflected on this page
  with a new effective date. Continuing to use the app after changes take effect
  means you accept the updated terms.</p>

  <h2>Contact</h2>
  <p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> ·
  <a href="/privacy">Privacy Policy</a></p>
`,
);

const router = Router();

router.get("/privacy", (_req: Request, res: Response) => {
  res.type("html").send(PRIVACY_HTML);
});

router.get("/terms", (_req: Request, res: Response) => {
  res.type("html").send(TERMS_HTML);
});

export default router;
