/** Local UI mutations must not be triggered by an unrelated website. CLI requests have no Origin. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
