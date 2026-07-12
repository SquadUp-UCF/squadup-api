/**
 * Branded HTML (and plain-text) email for the password-reset link.
 *
 * Shares the visual language of `verification-email.ts` — the deep-green hero
 * band, the wordmark beside the emblem badge, the same type stack — so both
 * auth emails read as the same product. See that file for why the markup is
 * table-based with inline styles and a solid-colour fallback under every
 * gradient (Outlook ignores `linear-gradient`).
 *
 * The reset URL is also rendered as plain text under the button: some clients
 * strip or rewrite anchors, and a link the user can copy is better than a
 * button that silently goes nowhere.
 */

/** Brand palette, lifted from the front-end auth shell (`.su-auth`). */
const BRAND = {
  green: '#1b7a32',
  greenDeep: '#0d4a1e',
  greenMid: '#1f6b3e',
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

export interface PasswordResetEmailParams {
  /** Absolute URL the user follows to choose a new password. */
  resetUrl: string;
  /** How long the link stays valid, in minutes. */
  expiresMinutes: number;
  /** Absolute URL to the Squad-Up emblem (square PNG). */
  logoUrl: string;
}

export interface PasswordResetEmail {
  subject: string;
  html: string;
  text: string;
}

/** Build the subject, HTML and plain-text bodies for a password-reset email. */
export function buildPasswordResetEmail({
  resetUrl,
  expiresMinutes,
  logoUrl,
}: PasswordResetEmailParams): PasswordResetEmail {
  const subject = 'Reset your Squad-Up password';

  const text = [
    'Squad-Up',
    '',
    'Reset your password',
    'Follow this link to choose a new password:',
    resetUrl,
    `The link expires in ${expiresMinutes} minutes and can only be used once.`,
    '',
    "If you didn't request a password reset, you can safely ignore this email —",
    'your password will not change.',
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
      Choose a new Squad-Up password. This link expires in ${expiresMinutes} minutes.
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

            <!-- Body: heading, action button, copyable link. -->
            <tr>
              <td style="padding:36px 32px 8px;">
                <h1 style="margin:0 0 8px;font-family:${DISPLAY_FONT};font-weight:800;font-size:28px;line-height:1.15;letter-spacing:-0.3px;color:${BRAND.text};">
                  Reset your password
                </h1>
                <p style="margin:0 0 28px;font-family:${BODY_FONT};font-size:16px;line-height:1.5;color:${BRAND.muted};">
                  Choose a new password for your Squad-Up account.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center">
                      <a href="${resetUrl}" style="display:inline-block;background-color:${BRAND.greenDeep};background-image:linear-gradient(135deg, ${BRAND.greenDeep} 0%, ${BRAND.green} 100%);color:#ffffff;font-family:${DISPLAY_FONT};font-weight:700;font-size:16px;text-decoration:none;padding:15px 40px;border-radius:12px;">
                        Reset password
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Copyable fallback: some clients strip or rewrite the button. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;">
                  <tr>
                    <td style="background:${BRAND.surface};border:1.5px solid ${BRAND.border};border-radius:14px;padding:16px;">
                      <p style="margin:0 0 6px;font-family:${BODY_FONT};font-size:13px;color:${BRAND.muted};">
                        Or paste this link into your browser:
                      </p>
                      <p style="margin:0;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${BRAND.text};word-break:break-all;">
                        ${resetUrl}
                      </p>
                    </td>
                  </tr>
                </table>

                <p style="margin:20px 0 0;font-family:${BODY_FONT};font-size:14px;line-height:1.5;color:${BRAND.muted};text-align:center;">
                  This link expires in <span style="color:${BRAND.green};font-weight:700;">${expiresMinutes} minutes</span> and can only be used once.
                </p>
              </td>
            </tr>

            <!-- Footer: security note. -->
            <tr>
              <td style="padding:24px 32px 32px;">
                <div style="border-top:1px solid ${BRAND.border};padding-top:20px;">
                  <p style="margin:0;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${BRAND.muted};">
                    Didn't request a password reset? You can safely ignore this email &mdash; your password will not change.
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
