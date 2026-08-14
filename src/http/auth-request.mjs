export async function resolveAuthenticatedUser(request, { authService, cookiePolicy }) {
  const sessionToken = cookiePolicy.parse(request.headers.cookie);
  return sessionToken ? authService.authenticate(sessionToken) : null;
}
