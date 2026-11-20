/** Whether the tracked domain (or a subdomain of it) is this site. */
export function isOwnSite(site: string | null, domain: string) {
  return site !== null && (site === domain || site.endsWith(`.${domain}`));
}
