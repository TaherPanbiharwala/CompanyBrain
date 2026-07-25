// Email normalization (DECISIONS D11). `email_normalized` is the invite-matching key, so this
// function decides whether an invite sent to one address matches the login of the person who
// actually shows up. It is also UNIQUE in the database, so two humans must never normalize to the
// same value, and one human must never normalize to two.
//
// Gmail treats dots as insignificant and everything after a `+` as a label, and serves
// googlemail.com as an alias of gmail.com. No other provider is assumed to do either — an invite to
// `foo@corp.com` deliberately does NOT match a `foo+x@corp.com` login, because at most providers
// those really are different mailboxes.

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// DELETED: emailDomain().
//
// It was exported, tested, and called by nothing — and it was the exact footgun this module's design
// forecloses. The org domain comes from the Google-signed `hd` claim ONLY (see google.ts and
// sessions.login_hd). Google sets `hd` only for Workspace accounts, so a consumer account can own a
// mailbox at any custom domain; deriving a workspace domain from the email's domain part would
// reopen the domain-squat that D37 exists to prevent. A tested helper sitting next to normalizeEmail
// is precisely what the next person reaching for "what domain is this user in" would find and use.
// If a future milestone genuinely needs the domain part for something non-authorizing, write it at
// the call site with that constraint stated.

/** Canonical form used for invite matching and stored in `principals.email_normalized`.
 *  ALWAYS lowercases the whole address; applies dot/plus stripping to Gmail only. */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) throw new Error(`not an email address: ${JSON.stringify(raw)}`);

  let local = trimmed.slice(0, at).toLowerCase();
  let domain = trimmed.slice(at + 1).toLowerCase();
  if (!domain) throw new Error(`email has an empty domain: ${JSON.stringify(raw)}`);

  if (GMAIL_DOMAINS.has(domain)) {
    // Fold the alias FIRST, so one Google human always yields one normalized address — otherwise an
    // invite to foo@gmail.com would never match a foo@googlemail.com login.
    domain = 'gmail.com';
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll('.', '');
  }

  if (!local) throw new Error(`email normalizes to an empty local part: ${JSON.stringify(raw)}`);
  return `${local}@${domain}`;
}
