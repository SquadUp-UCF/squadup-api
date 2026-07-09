/**
 * Branded HTML (and plain-text) email for the one-time verification code.
 *
 * The look mirrors the Squad-Up web app's auth screens (see the front-end
 * `AuthShell.css`): the deep-green hero gradient, the "Squad-Up" wordmark next
 * to the emblem badge, and the light-green surface used for the code — so the
 * email reads as the same product as the page that asked for it.
 *
 * Email-client realities shape the markup: table-based layout with inline
 * styles, a solid-colour fallback under every gradient (Outlook ignores
 * `linear-gradient`), and web fonts that degrade to a system stack when the
 * client won't load them. The emblem is a remote image with the text wordmark
 * always beside it, so a client that blocks images still shows the brand.
 */

/** Brand palette, lifted from the front-end auth shell (`.su-auth`). */
const BRAND = {
  green: '#1b7a32',
  greenDeep: '#0d4a1e',
  greenMid: '#1f6b3e',
  accent: '#a8e6b8',
  text: '#0d2b18',
  muted: '#6b9478',
  surface: '#eaf4e4',
  border: 'rgba(13, 80, 40, 0.14)',
  page: '#f4f7f2',
};

/** Outfit/DM Sans when available, otherwise a robust system fallback. */
const DISPLAY_FONT =
  "'Outfit', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BODY_FONT = "'DM Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface VerificationEmailParams {
  /** The 6-digit code. Rendered contiguously; spacing is CSS-only. */
  code: string;
  /** How long the code stays valid, in minutes. */
  expiresMinutes: number;
  /** Absolute URL to the Squad-Up emblem (square PNG). */
  logoUrl: string;
}

export interface VerificationEmail {
  subject: string;
  html: string;
  text: string;
}

/** Build the subject, HTML and plain-text bodies for a verification email. */
export function buildVerificationEmail({
  code,
  expiresMinutes,
  logoUrl,
}: VerificationEmailParams): VerificationEmail {
  const subject = 'Your Squad-Up verification code';

  const text = [
    'Squad-Up',
    '',
    'Verify your email',
    `Your one-time verification code is: ${code}`,
    `It expires in ${expiresMinutes} minutes.`,
    '',
    "If you didn't request this code, you can safely ignore this email.",
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light only" />
    <meta name="supported-color-schemes" content="light" />
    <link
      href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;700;800&family=DM+Sans:wght@400;500;700&display=swap"
      rel="stylesheet"
    />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.page};">
    <!-- Preheader: shown in the inbox preview, hidden in the body. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Your Squad-Up code is ${code}. It expires in ${expiresMinutes} minutes.
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 10px 24px rgba(13,74,30,0.10);">

            <!-- Header: green hero band with the Squad-Up wordmark. -->
            <tr>
              <td style="background-color:${BRAND.greenDeep};background-image:linear-gradient(135deg, ${BRAND.greenDeep} 0%, ${BRAND.greenMid} 55%, ${BRAND.green} 100%);padding:28px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <span style="display:inline-block;width:44px;height:44px;background:#ffffff;border-radius:14px;text-align:center;line-height:44px;box-shadow:0 2px 6px rgba(0,0,0,0.15);">
                        <img src="${logoUrl}" width="30" height="30" alt="Squad-Up" style="display:inline-block;vertical-align:middle;border:0;border-radius:8px;" />
                      </span>
                    </td>
                    <td style="vertical-align:middle;padding-left:12px;">
                      <span style="font-family:${DISPLAY_FONT};font-weight:800;font-size:26px;color:#ffffff;letter-spacing:-0.3px;">Squad-Up</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body: heading, code, expiry. -->
            <tr>
              <td style="padding:36px 32px 8px;">
                <h1 style="margin:0 0 8px;font-family:${DISPLAY_FONT};font-weight:800;font-size:28px;line-height:1.15;letter-spacing:-0.3px;color:${BRAND.text};">
                  Verify your email
                </h1>
                <p style="margin:0 0 28px;font-family:${BODY_FONT};font-size:16px;line-height:1.5;color:${BRAND.muted};">
                  Enter this one-time code to finish signing in to Squad-Up.
                </p>

                <!-- Code box: the app's light-green surface. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="background:${BRAND.surface};border:1.5px solid ${BRAND.border};border-radius:14px;padding:22px 16px;">
                      <div style="font-family:${DISPLAY_FONT};font-weight:800;font-size:40px;line-height:1;letter-spacing:12px;color:${BRAND.text};padding-left:12px;">${code}</div>
                    </td>
                  </tr>
                </table>

                <p style="margin:20px 0 0;font-family:${BODY_FONT};font-size:14px;line-height:1.5;color:${BRAND.muted};text-align:center;">
                  This code expires in <span style="color:${BRAND.green};font-weight:700;">${expiresMinutes} minutes</span>.
                </p>
              </td>
            </tr>

            <!-- Footer: security note. -->
            <tr>
              <td style="padding:24px 32px 32px;">
                <div style="border-top:1px solid ${BRAND.border};padding-top:20px;">
                  <p style="margin:0;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${BRAND.muted};">
                    Didn't request this? You can safely ignore this email &mdash; someone may have typed your address by mistake.
                  </p>
                </div>
              </td>
            </tr>
          </table>

          <p style="margin:20px 0 0;font-family:${BODY_FONT};font-size:12px;color:${BRAND.muted};">
            &copy; Squad-Up UCF
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
