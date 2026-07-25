// Public email providers. Gates DOMAIN AUTO-JOIN only (DECISIONS D11) — it never blocks anyone from
// signing in or from creating their own workspace. Without it, the first gmail.com user to claim the
// domain would auto-join every other Gmail user on the planet into their workspace.
//
// Checked-in code rather than a table: it is security-load-bearing, tiny, and changes rarely, so it
// belongs in version control where a change is reviewed — same reasoning as DEV_ENVS in config.ts.
//
// In practice a public domain is already unreachable here, because a domain can only be claimed from
// a verified Google `hd` claim and Google sets `hd` only for Workspace accounts. This is the second
// layer: it would still hold if the `hd` rule were ever loosened.
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'ymail.com',
  'rediffmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'zoho.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
]);

export function isPublicDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}
