/** A role from the project's owners (the model before #197): the default owner, a writer, or a viewer. */
export function roleFromOwners(user, owners) {
    if (!user)
        return null;
    const u = user.toLowerCase();
    if (u === owners.default.toLowerCase())
        return 'owner';
    return owners.writers.some((w) => w.toLowerCase() === u) ? 'writer' : 'viewer';
}
/**
 * The session for a dashboard with one configured user (before #197): their role from project.owners. The per-install token already authenticated the request, and it isn't a cookie, so CSRF
 * doesn't apply to it.
 */
export const fixedUserSession = (user, owners) => () => ({ login: user, role: roleFromOwners(user, owners), csrfOk: true });
//# sourceMappingURL=session.js.map