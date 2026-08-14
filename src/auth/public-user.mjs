export function toPublicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.emailOriginal,
    createdAt: user.createdAt
  };
}
