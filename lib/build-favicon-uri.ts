import fs from 'fs';
import path from 'path';

/**
 * Returns a favicon URI to embed in Next.js metadata.
 *
 * Checks public/favicon.{png,jpg,jpeg,webp} first — a small, simplified mark
 * meant to stay legible at tab-icon size (16–32px), independent from the
 * full in-app logo. Falls back to public/logo.{png,jpg,jpeg,webp} if no
 * dedicated favicon file is present, so existing deployments keep working
 * unchanged.
 *
 * When neither is present, an SVG letter-in-box is built from the app name
 * env var and the primary colour read from globals.css (patched by the App
 * Builder at deploy time). Base64 encoding is used instead of a
 * percent-encoded raw SVG to guarantee cross-browser compatibility — Firefox
 * and Safari misparse raw '#' characters inside text-based data URIs.
 */
export function buildFaviconUri(): string | null {
  const publicDir = path.join(process.cwd(), 'public');

  // public/favicon.<ext> — dedicated tab-icon asset, independent of the
  // in-app Header logo. Preferred when present.
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    if (fs.existsSync(path.join(publicDir, `favicon.${ext}`))) {
      return `/favicon.${ext}`;
    }
  }

  // public/logo.<ext> — used by the Header component. Falls back to this
  // for the favicon too when no dedicated favicon file exists, so older
  // deployments without a favicon.<ext> render exactly as before.
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    if (fs.existsSync(path.join(publicDir, `logo.${ext}`))) {
      return `/logo.${ext}`;
    }
  }

  const appName =
    process.env.NEXT_PUBLIC_DERIV_APP_NAME?.trim() || 'Deriv App';
  const letter = appName.trim().charAt(0).toUpperCase() || 'A';

  // The App Builder patches globals.css with the user's chosen brand colour as
  // space-separated RGB channels (Tailwind format), e.g. "255 174 38".
  // Parse and convert to hex for use inside the SVG fill attribute.
  // Neutral fallback — only reached if globals.css is unreadable (e.g. a
  // stripped test environment). In all real builds globals.css is present and
  // --primary is always defined, so this value is never seen in production.
  let bgColor = '#000000';
  try {
    const css = fs.readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf-8');
    const match = css.match(/--primary:\s*(\d+)\s+(\d+)\s+(\d+)/);
    if (match) {
      bgColor =
        '#' +
        [match[1], match[2], match[3]]
          .map((ch) => parseInt(ch, 10).toString(16).padStart(2, '0'))
          .join('');
    }
  } catch {
    // globals.css unreadable — keep templateColorFallback
  }

  const svgString = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
    `<rect width="32" height="32" rx="6" fill="${bgColor}"/>`,
    '<text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle"',
    ` fill="white" font-size="20" font-family="sans-serif" font-weight="bold">${letter}</text>`,
    '</svg>',
  ].join('');

  const base64Svg = Buffer.from(svgString).toString('base64');
  return `data:image/svg+xml;base64,${base64Svg}`;
}
